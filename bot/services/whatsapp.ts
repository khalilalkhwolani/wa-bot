import { Boom } from '@hapi/boom'
import makeWASocket, { 
	DisconnectReason, 
	fetchLatestBaileysVersion, 
	isJidNewsletter, 
	makeCacheableSignalKeyStore, 
	useMultiFileAuthState 
} from '../../src'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import path from 'path'
import PQueue from 'p-queue'
import { config, normalizeArabic } from '../config'
import {
	claimLinkForSending,
	isSupabaseLinkStoreConfigured,
	markLinkFailed,
	markLinkSent,
	parseWhatsAppLink,
} from '../database/supabaseLinks'
import type { LinkClaim, LinkIdentity } from '../database/supabaseLinks'
import type { SLIEMessage } from '../slie/types'

// على Render: سجل خفيف بدون pino-pretty حتى لا يأكل رام زيادة
const logger = process.env.RENDER || process.env.NODE_ENV === 'production'
	? P({ level: 'info' })
	: P({
		level: 'info',
		transport: {
			target: 'pino-pretty',
			options: { colorize: true }
		}
	})

// خرائط تخزين معرفات المجموعات لتجنب التكرار (Session ID -> JID)
const sessionLinksGroupJids = new Map<string, string>()
const sessionLeadsGroupJids = new Map<string, string>()
const groupNamesMap = new Map<string, string>()

// خريطة لتخزين اتصالات الجلسات النشطة لمشاركتها (Session ID -> socket)
export const activeSockets = new Map<string, any>()
const sentLinkMessages = new Map<string, { linkId: string; serial: number; targetJid: string }>()
const verifiedSenderTargets = new Set<string>()

// وقت تشغيل البوت لتفادي معالجة الرسائل القديمة المؤرشفة
const botStartupTime = Date.now()

// طابور عالمي واحد للروابط: يمنع سباق الترقيم بين حسابات المراقبة
const linksQueue = new PQueue({ concurrency: 1 })
const sessionLeadsQueues = new Map<string, PQueue>()

// واتساب قد يعيد حدث notify نفسه أكثر من مرة؛ نمنع إعادة معالجة نفس الرسالة محليًا.
const recentlyProcessedMessages = new Map<string, number>()
const duplicateLinkLogTimes = new Map<string, number>()
const MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000
const DUPLICATE_LOG_TTL_MS = 60 * 1000

function isRepeatedMessage(sessionId: string, msg: any): boolean {
	const messageId = msg.key?.id
	if (!messageId) return false
	const key = `${sessionId}|${msg.key?.remoteJid || ''}|${messageId}`
	const now = Date.now()
	const seenAt = recentlyProcessedMessages.get(key)
	recentlyProcessedMessages.set(key, now)

	if (recentlyProcessedMessages.size > 20_000) {
		for (const [storedKey, storedAt] of recentlyProcessedMessages) {
			if (now - storedAt > MESSAGE_DEDUP_TTL_MS) recentlyProcessedMessages.delete(storedKey)
		}
	}
	return seenAt !== undefined && now - seenAt <= MESSAGE_DEDUP_TTL_MS
}

function shouldLogDuplicate(sessionId: string, canonicalKey: string): boolean {
	const key = `${sessionId}|${canonicalKey}`
	const now = Date.now()
	const previous = duplicateLinkLogTimes.get(key)
	duplicateLinkLogTimes.set(key, now)
	return previous === undefined || now - previous > DUPLICATE_LOG_TTL_MS
}

async function claimLinkWithRecovery(
	input: Parameters<typeof claimLinkForSending>[0],
	sessionId: string,
	link: LinkIdentity
): Promise<LinkClaim> {
	let outageAttempt = 0
	for (;;) {
		try {
			return await claimLinkForSending(input)
		} catch (error) {
			const message = String(error)
			const transient = message.includes('failed after 3 attempts')
			if (!transient) throw error

			outageAttempt += 1
			const delayMs = Math.min(60_000, 5_000 * 2 ** Math.min(outageAttempt - 1, 4))
			logger.warn(
				`⏳ [${sessionId}] Supabase غير متاح مؤقتًا؛ الرابط ${link.canonicalKey} محفوظ في الطابور ` +
				`وستعاد المحاولة بعد ${Math.round(delayMs / 1000)} ثوانٍ (محاولة الاستعادة ${outageAttempt})`
			)
			await new Promise(resolve => setTimeout(resolve, delayMs))
		}
	}
}

/** منع تشغيل/إعادة اتصال مزدوج لنفس الحساب */
const startingSessions = new Set<string>()
const reconnectScheduled = new Set<string>()

function isReadOnlySession(sessionId: string): boolean {
	return ((config as any).READ_ONLY_SESSIONS || []).includes(sessionId)
}

function jidUser(jid: unknown): string {
	return String(jid || '').split('@')[0].split(':')[0]
}

function maskedJid(jid: unknown): string {
	const user = jidUser(jid)
	return user ? `***${user.slice(-4)}` : 'غير معروف'
}

/**
 * دالة لتشغيل وإدارة جلسة عمل واتساب
 */
export async function startWhatsAppSession(sessionId: string) {
	if (startingSessions.has(sessionId)) {
		logger.warn(`⏳ [${sessionId}] تهيئة قيد التنفيذ — تم تجاهل طلب مكرر`)
		return
	}
	startingSessions.add(sessionId)

	try {
	logger.info(`🔌 جاري تهيئة الاتصال للحساب: [${sessionId}]...`)

	// إنشاء طوابير إرسال مستقلة
	const leadsQueue = new PQueue({ concurrency: 1 })
	sessionLeadsQueues.set(sessionId, leadsQueue)

	const authFolder = path.join('sessions', `auth_info_${sessionId}`)
	const { state, saveCreds } = await useMultiFileAuthState(authFolder)
	const fetched = await fetchLatestBaileysVersion()
	// واتساب يرفض الإصدارات القديمة بـ 405 قبل ما يطلع QR
	const minRevision = 1046388543
	const version: [number, number, number] =
		fetched.version[2] >= minRevision ? fetched.version : [2, 3000, minRevision]
	logger.info(`📟 [${sessionId}] إصدار واتساب ويب ${version.join('.')}`)

	// أغلق مقبس قديم قبل فتح جديد (يمنع تصادم الجلسة)
	const oldSock = activeSockets.get(sessionId)
	if (oldSock) {
		try {
			(oldSock.ev as any)?.removeAllListeners?.()
			oldSock.end?.(undefined)
			oldSock.ws?.close?.()
		} catch {
			// تجاهل
		}
		activeSockets.delete(sessionId)
	}

	const sock = makeWASocket({
		version,
		logger: P({ level: 'silent' }),
		printQRInTerminal: false,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		generateHighQualityLinkPreview: false,
		syncFullHistory: false,
		shouldSyncHistoryMessage: () => false,
		markOnlineOnConnect: false,
		connectTimeoutMs: 60_000,
		keepAliveIntervalMs: 25_000,
		defaultQueryTimeoutMs: 60_000,
	})

	// حفظ حالة المصادقة عند التحديث
	sock.ev.on('creds.update', saveCreds)

	// متابعة تأكيدات واتساب للروابط المرسلة، بدل الاكتفاء بإنشاء معرف الرسالة.
	sock.ev.on('messages.update', (updates: any[]) => {
		const statusNames: Record<number, string> = {
			0: 'ERROR',
			1: 'PENDING',
			2: 'SERVER_ACK',
			3: 'DELIVERED',
			4: 'READ',
			5: 'PLAYED',
		}
		for (const item of updates) {
			const messageId = item.key?.id
			const tracked = messageId ? sentLinkMessages.get(messageId) : undefined
			if (!tracked || item.update?.status == null) continue
			const status = Number(item.update.status)
			logger.info(`📬 الرابط #${tracked.serial} حالة واتساب=${statusNames[status] || status} الوجهة=${tracked.targetJid}`)
			if (status === 0) {
				markLinkFailed(tracked.linkId, 'WhatsApp reported message status ERROR').catch(error => {
					logger.error(`❌ تعذر تسجيل فشل الرابط #${tracked.serial}: ${error}`)
				})
				sentLinkMessages.delete(messageId)
			} else if (status >= 2) {
				markLinkSent(tracked.linkId, messageId).then(() => {
					logger.info(`✅ تأكد وصول الرابط #${tracked.serial} من واتساب (${statusNames[status] || status})`)
					sentLinkMessages.delete(messageId)
				}).catch(error => logger.error(`❌ تعذر تثبيت وصول الرابط #${tracked.serial}: ${error}`))
			}
		}
	})

	// في المجموعات تصل تأكيدات التسليم عادةً كإيصالات خاصة بكل عضو.
	sock.ev.on('message-receipt.update', (updates: any[]) => {
		for (const item of updates) {
			const messageId = item.key?.id
			const tracked = messageId ? sentLinkMessages.get(messageId) : undefined
			if (!tracked) continue
			if (!item.receipt?.receiptTimestamp && !item.receipt?.readTimestamp) continue
			markLinkSent(tracked.linkId, messageId).then(() => {
				logger.info(`✅ تأكد تسليم الرابط #${tracked.serial} داخل مجموعة واتساب (${tracked.targetJid})`)
				sentLinkMessages.delete(messageId)
			}).catch(error => logger.error(`❌ تعذر تثبيت تسليم الرابط #${tracked.serial}: ${error}`))
		}
	})

	// التعامل مع تحديثات الاتصال وإعادة الاتصال الذكية
	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, qr } = update

		if (qr) {
			logger.info(`📸 يرجى مسح رمز الـ QR التالي للاتصال بالحساب [${sessionId}]:`)
			qrcode.generate(qr, { small: true })
		}

		if (connection === 'close') {
			activeSockets.delete(sessionId)
			verifiedSenderTargets.delete(`${sessionId}|${config.TARGET_LINKS_GROUP}`)
			const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
			const shouldReconnect = statusCode !== DisconnectReason.loggedOut
			logger.error(
				`❌ انقطع الاتصال للحساب [${sessionId}]. statusCode=${statusCode ?? 'n/a'} السبب: ${lastDisconnect?.error}`
			)

			try {
				(sock.ev as any)?.removeAllListeners?.()
				sock.end?.(undefined)
				sock.ws?.close?.()
			} catch {
				// تجاهل
			}

			if (shouldReconnect) {
				if (reconnectScheduled.has(sessionId)) return
				reconnectScheduled.add(sessionId)
				logger.info(`🔄 جاري محاولة إعادة الاتصال خلال 8 ثوانٍ للحساب [${sessionId}]...`)
				setTimeout(() => {
					reconnectScheduled.delete(sessionId)
					startWhatsAppSession(sessionId).catch(err => {
						logger.error(`❌ فشل إعادة تشغيل [${sessionId}]: ${err}`)
					})
				}, 8000)
			} else {
				logger.error(`⚠️ تم تسجيل الخروج للحساب [${sessionId}]. يرجى إزالة المجلد ${authFolder} وإعادة التشغيل.`)
			}
		} else if (connection === 'open') {
			reconnectScheduled.delete(sessionId)
			activeSockets.set(sessionId, sock)
			const mode = isReadOnlySession(sessionId) ? ' (قراءة فقط)' : ''
			logger.info(`✅ تم فتح الاتصال بنجاح للحساب [${sessionId}]${mode}!`)
			lookupGroupJids(sock, sessionId).catch(err => {
				logger.warn(`⚠️ [${sessionId}] تنبيه جلب المجموعات: ${err}`)
			})
		}
	})

	// مراقبة الرسائل الواردة وتوجيهها للمحركات المناسبة
	sock.ev.on('messages.upsert', async (upsert) => {
		if (upsert.type !== 'notify') return

		for (const msg of upsert.messages) {
			if (msg.key.fromMe) continue
			if (msg.key.remoteJid && isJidNewsletter(msg.key.remoteJid)) continue
			if (isRepeatedMessage(sessionId, msg)) continue

			// تجنب معالجة أي رسائل مرسلة داخل مجموعات التوجيه والعمل الخاصة بالبوت نفسه لتفادي حلقات التغذية الراجعة
			const isTargetGroup = [...sessionLinksGroupJids.values()].includes(msg.key.remoteJid || '') ||
			                      [...sessionLeadsGroupJids.values()].includes(msg.key.remoteJid || '')
			if (isTargetGroup) {
				continue
			}

			// تجنب الرسائل القديمة أو التاريخية المرسلة قبل تشغيل البوت لمنع التكرار عند إعادة التشغيل
			const msgTime = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()
			if (msgTime < botStartupTime - 15000) {
				continue
			}

			// 1. معالجة تفاعلات المشرفين بالرموز للتغذية الراجعة (Reaction Feedback)
			if (msg.message?.reactionMessage) {
				const reaction = msg.message.reactionMessage
				const targetKey = reaction.key
				const emoji = reaction.text || ''
				
				const leadsGroupJid = sessionLeadsGroupJids.get(sessionId)
				if (leadsGroupJid && targetKey?.remoteJid === leadsGroupJid) {
					await handleModeratorReaction(sock, sessionId, targetKey?.id || '', emoji)
				}
				continue
			}

			// استخراج النص المباشر
			const text = msg.message?.conversation || 
						 msg.message?.extendedTextMessage?.text || 
						 msg.message?.imageMessage?.caption || 
						 msg.message?.videoMessage?.caption || 
						 ''

			// استخراج النص المقتبس (Quoted message)
			const quotedMsgObj = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
			let quotedText = ''
			if (quotedMsgObj) {
				quotedText = quotedMsgObj.conversation || 
							 quotedMsgObj.extendedTextMessage?.text || 
							 quotedMsgObj.imageMessage?.caption || 
							 quotedMsgObj.videoMessage?.caption || 
							 ''
			}

			// 2. معالجة الروابط الرسمية وتوجيهها لمجموعة العمل (Links Catcher)
			// القروبات: https://chat.whatsapp.com/... أو https://whatsapp.com/invite/...
			// القنوات: https://whatsapp.com/channel/...
			const officialWaLinkRegex =
				/https:\/\/(?:chat\.whatsapp\.com\/(?:invite\/)?|whatsapp\.com\/invite\/|whatsapp\.com\/channel\/)([A-Za-z0-9_-]+)/gi
			let foundOfficialLinks = false
			if (text) {
				const links: { link: string; code: string }[] = []
				let match
				while ((match = officialWaLinkRegex.exec(text)) !== null) {
					links.push({ link: match[0], code: match[1] || '' })
				}

				if (links.length > 0) {
					foundOfficialLinks = true
					handleGroupLinks(sock, sessionId, msg, text, links)
				}
			}

			// إذا كانت الرسالة تحتوي على روابط رسمية (قروبات/قنوات)، نتخطى محرك طلبات الطلاب (SLIE) تماماً للفصل التام
			if (foundOfficialLinks) {
				continue
			}

			// مسار طلبات الطلاب متوقف حالياً
			if (!(config as any).ENABLE_STUDENT_LEADS) {
				continue
			}

			// 3. معالجة طلبات مساعدة الطلاب عبر الأنبوب المعياري (SLIE Engine Pipeline)
			if (text || quotedText) {
				let participantJid = msg.key.participantAlt || msg.key.participant || ''
				if (!participantJid && msg.key.remoteJid && !msg.key.remoteJid.endsWith('@g.us')) {
					participantJid = msg.key.remoteJid
				}

				const sliemMsg: SLIEMessage = {
					id: msg.key.id || '',
					remoteJid: msg.key.remoteJid || '',
					participant: participantJid,
					participantAlt: msg.key.participantAlt,
					pushName: msg.pushName || 'غير مسجل',
					text,
					quotedText,
					timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
					rawMessage: msg
				}

				const { contextBuilder } = await import('../slie')
				contextBuilder.addMessage(sliemMsg, (combinedMsg) => {
					handleStudentLeadMessage(sock, sessionId, combinedMsg)
				})
			}
		}
	})
	} finally {
		startingSessions.delete(sessionId)
	}
}

/**
 * البحث عن معرفات المجموعات المستهدفة عند الاتصال وتعيينها بدقة
 */
async function lookupGroupJids(sock: any, sessionId: string) {
	// 1) تعيين فوري بالـ JID — هذا يكفي للتشغيل (لا حاجة لجلب كل القروبات)
	if (config.TARGET_LINKS_GROUP && config.TARGET_LINKS_GROUP.endsWith('@g.us')) {
		sessionLinksGroupJids.set(sessionId, config.TARGET_LINKS_GROUP)
		logger.info(`🎯 تم تعيين مجموعة الروابط مباشرة بالمعرف الفريد (JID): ${config.TARGET_LINKS_GROUP}`)
		if (sessionId === config.SENDER_SESSION) {
			try {
				const metadata = await sock.groupMetadata(config.TARGET_LINKS_GROUP)
				logger.info(`📨 مجموعة إرسال الروابط الفعلية: "${metadata?.subject || 'غير معروف'}" (${config.TARGET_LINKS_GROUP})`)
				const ownUsers = new Set([jidUser(sock.user?.id), jidUser(sock.user?.lid)].filter(Boolean))
				const ownParticipant = metadata?.participants?.find((participant: any) =>
					[participant.id, participant.lid, participant.phoneNumber].some(jid => ownUsers.has(jidUser(jid)))
				)
				const isAdmin = Boolean(
					ownParticipant?.isAdmin || ownParticipant?.isSuperAdmin ||
					ownParticipant?.admin === 'admin' || ownParticipant?.admin === 'superadmin'
				)
				const canSend = Boolean(ownParticipant) && (!metadata?.announce || isAdmin)
				logger.info(
					`🔐 حساب الإرسال=${maskedJid(sock.user?.id)} عضو=${Boolean(ownParticipant)} ` +
					`مشرف=${isAdmin} المجموعة_للمشرفين_فقط=${Boolean(metadata?.announce)}`
				)
				if (!canSend) {
					throw new Error(`حساب الإرسال [${sessionId}] ليس عضوًا مخولًا بالإرسال داخل مجموعة العمل`)
				}
				verifiedSenderTargets.add(`${sessionId}|${config.TARGET_LINKS_GROUP}`)
			} catch (error) {
				logger.error(`❌ تعذر على حساب الإرسال التحقق من مجموعة الروابط ${config.TARGET_LINKS_GROUP}: ${error}`)
			}
		}
	}
	if (config.TARGET_LEADS_GROUP && config.TARGET_LEADS_GROUP.endsWith('@g.us')) {
		sessionLeadsGroupJids.set(sessionId, config.TARGET_LEADS_GROUP)
		logger.info(`🎯 تم تعيين مجموعة الطلاب مباشرة بالمعرف الفريد (JID): ${config.TARGET_LEADS_GROUP}`)
	}

	const linksIsJid = !!(config.TARGET_LINKS_GROUP && config.TARGET_LINKS_GROUP.endsWith('@g.us'))
	const leadsIsJid = !!(config.TARGET_LEADS_GROUP && config.TARGET_LEADS_GROUP.endsWith('@g.us'))

	// إذا الوجهات محددة بـ JID: نتوقف هنا — جلب كل القروبات بطيء وغير مطلوب
	if (linksIsJid && leadsIsJid) {
		logger.info(`⏭️ [${sessionId}] تخطي جلب قائمة القروبات — الوجهات محددة مسبقًا`)
		return
	}

	try {
		logger.info(`🔍 جاري جلب المجموعات للحساب [${sessionId}] في الخلفية...`)
		const groups = await Promise.race([
			sock.groupFetchAllParticipating(),
			new Promise<Record<string, never>>((_, reject) =>
				setTimeout(() => reject(new Error('انتهت مهلة جلب المجموعات (15ث)')), 15_000)
			)
		]) as Record<string, { subject?: string }>

		console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
		console.log(`📋 المجموعات النشطة للحساب [${sessionId}]:`)
		for (const jid in groups) {
			console.log(`   - الاسم: "${groups[jid].subject}" | المعرّف (JID): ${jid}`)
			if (groups[jid].subject) {
				groupNamesMap.set(jid, groups[jid].subject!)
			}
		}
		console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

		const linksNorm = normalizeArabic(config.TARGET_LINKS_GROUP)
		const leadsNorm = normalizeArabic(config.TARGET_LEADS_GROUP)

		for (const jid in groups) {
			const subject = groups[jid].subject || ''
			const subjectNorm = normalizeArabic(subject)

			if (!sessionLinksGroupJids.has(sessionId)) {
				if (subject === config.TARGET_LINKS_GROUP || subjectNorm === linksNorm) {
					sessionLinksGroupJids.set(sessionId, jid)
					logger.info(`✅ تم العثور على مجموعة الروابط بالاسم: "${subject}" بالمعرف: ${jid}`)
				}
			}

			if (!sessionLeadsGroupJids.has(sessionId)) {
				if (subject === config.TARGET_LEADS_GROUP || subjectNorm === leadsNorm) {
					sessionLeadsGroupJids.set(sessionId, jid)
					logger.info(`✅ تم العثور على مجموعة الطلاب بالاسم: "${subject}" بالمعرف: ${jid}`)
				}
			}
		}

		if (!sessionLinksGroupJids.has(sessionId)) {
			logger.warn(`⚠️ لم يتم تحديد مجموعة الروابط المستهدفة [${config.TARGET_LINKS_GROUP}] للحساب [${sessionId}]`)
		}
		if (!sessionLeadsGroupJids.has(sessionId)) {
			logger.warn(`⚠️ لم يتم تحديد مجموعة الطلاب المستهدفة [${config.TARGET_LEADS_GROUP}] للحساب [${sessionId}]`)
		}
	} catch (err) {
		logger.warn(`⚠️ [${sessionId}] تنبيه جلب المجموعات: ${err}`)
	}
}

/**
 * معالجة وتصفية وتوجيه روابط المجموعات
 */
async function handleGroupLinks(sock: any, sessionId: string, msg: any, text: string, links: { link: string; code: string }[]) {
	const senderSessionId = (config as any).SENDER_SESSION || sessionId
	const directLinksJid = config.TARGET_LINKS_GROUP?.endsWith('@g.us') ? config.TARGET_LINKS_GROUP : undefined
	// وجهة الإرسال: JID مباشر أولاً، ثم جلسة الإرسال، ثم أي جلسة أخرى
	const linksGroupJid =
		directLinksJid ||
		sessionLinksGroupJids.get(senderSessionId) ||
		sessionLinksGroupJids.get(sessionId) ||
		[...sessionLinksGroupJids.values()][0]

	if (!linksGroupJid) {
		logger.warn(`⚠️ [${sessionId}] رابط مرصود لكن مجموعة العمل غير معيّنة (sender=${senderSessionId})`)
		return
	}

	linksQueue.add(async () => {
		const cleanLinks = [...new Map(
			links
				.map(item => parseWhatsAppLink(item.link))
				.filter((item): item is NonNullable<typeof item> => item !== null)
				.map(item => [item.canonicalKey, item.url])
		).values()]
		if (cleanLinks.length === 0) return

		if (!isSupabaseLinkStoreConfigured()) {
			logger.error(`⏸️ [${sessionId}] قاعدة Supabase للروابط غير مضبوطة — تم إيقاف الإرسال لمنع التكرار`)
			return
		}

		const rawParticipant = msg.key.participantAlt || msg.key.participant || msg.key.remoteJid || ''
		const linkPhone = rawParticipant.split('@')[0].split(':')[0] || 'غير معروف'

		// تحديد اسم المجموعة المصدر مرة واحدة لكل رسالة
		let groupName = 'غير معروف'
		if (msg.key.remoteJid) {
			if (msg.key.remoteJid.endsWith('@g.us')) {
				groupName = groupNamesMap.get(msg.key.remoteJid) || 'غير معروف'
				if (groupName === 'غير معروف') {
					try {
						const metadata = await sock.groupMetadata(msg.key.remoteJid)
						groupName = metadata?.subject || 'غير معروف'
						if (metadata?.subject) {
							groupNamesMap.set(msg.key.remoteJid, metadata.subject)
						}
					} catch {
						groupName = 'غير معروف'
					}
				}
			} else {
				groupName = 'خاص'
			}
		}

		for (const rawLink of cleanLinks) {
			const link = parseWhatsAppLink(rawLink)
			if (!link) continue

			if (config.LINK_FORWARDING_DRY_RUN) {
				logger.info(`🧪 [${sessionId}] dry-run: تم رصد ${link.canonicalKey} دون حجز رقم أو إرسال`)
				continue
			}

			let claim
			try {
				claim = await claimLinkWithRecovery({
					link,
					sessionId,
					sourceGroupJid: msg.key.remoteJid || undefined,
					sourceGroupName: groupName,
					sourceMessageId: msg.key.id || undefined,
					sourceSenderJid: rawParticipant || undefined,
					observedAt: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : undefined,
				}, sessionId, link)
			} catch (err) {
				logger.error(`⏸️ [${sessionId}] فشل حجز الرابط في Supabase؛ لن يتم الإرسال: ${err}`)
				continue
			}

			if (!claim.shouldSend || claim.displaySerial == null) {
				if (shouldLogDuplicate(sessionId, link.canonicalKey)) {
					logger.info(`⏭️ [${sessionId}] رابط مكرر/محجوز تم تجاهله: ${link.canonicalKey} (${claim.currentStatus})`)
				}
				continue
			}

			let senderSock = activeSockets.get(senderSessionId)
			for (let i = 0; i < 6 && !senderSock; i++) {
				await new Promise(r => setTimeout(r, 2000))
				senderSock = activeSockets.get(senderSessionId)
			}
			if (!senderSock) {
				await markLinkFailed(claim.linkId, `Sender ${senderSessionId} is offline`).catch(() => {})
				logger.warn(`⏸️ [${sessionId}] المرسل الوحيد [${senderSessionId}] غير متصل — لن يستخدم النظام حسابًا بديلًا`)
				continue
			}
			if (!verifiedSenderTargets.has(`${senderSessionId}|${linksGroupJid}`)) {
				await markLinkFailed(claim.linkId, `Sender ${senderSessionId} is not verified for target ${linksGroupJid}`).catch(() => {})
				logger.error(`⏸️ [${sessionId}] لم يتم التحقق من صلاحية [${senderSessionId}] للإرسال إلى ${linksGroupJid}`)
				continue
			}

			const alertMessage = `🔗 *رابط واتساب جديد #${claim.displaySerial}*
*المصدر:* ${groupName}
${link.url}`

			try {
				const sent = await senderSock.sendMessage(linksGroupJid, { text: alertMessage }, { linkPreview: false })
				if (!sent?.key?.id) throw new Error('WhatsApp send returned no message id')
				if (sent.key.remoteJid && sent.key.remoteJid !== linksGroupJid) {
					throw new Error(`WhatsApp returned unexpected target ${sent.key.remoteJid}; expected ${linksGroupJid}`)
				}
				sentLinkMessages.set(sent.key.id, {
					linkId: claim.linkId,
					serial: claim.displaySerial,
					targetJid: linksGroupJid,
				})
				logger.info(
					`📤 [${sessionId}] سُلّم الرابط #${claim.displaySerial} لاتصال واتساب وينتظر تأكيد الوصول: msgId=${sent.key.id} | ` +
					`عبر=${senderSessionId} | الوجهة=${linksGroupJid}`
				)
			} catch (err) {
				await markLinkFailed(claim.linkId, err).catch(markErr => {
					logger.error(`❌ تعذر تسجيل فشل الرابط ${claim.linkId} في Supabase: ${markErr}`)
				})
				logger.error(`❌ [${sessionId}] فشل إرسال الرابط #${claim.displaySerial} عبر [${senderSessionId}]: ${err}`)
			}
		}
	})
}

/**
 * معالجة طلبات مساعدة الطلاب عبر أنبوب SLIE المعياري
 */
async function handleStudentLeadMessage(sock: any, sessionId: string, sliemMsg: SLIEMessage) {
	const { db } = await import('../database/database')
	const { runSLIEPipeline } = await import('../slie')
	const senderSessionId = (config as any).SENDER_SESSION || sessionId
	const leadsGroupJid = sessionLeadsGroupJids.get(senderSessionId)
	if (!leadsGroupJid) return

	const queue = sessionLeadsQueues.get(sessionId)
	if (!queue) return

	const participantJid = sliemMsg.participant
	const phone = participantJid.split('@')[0].split(':')[0]

	// 1. التحقق من عدم تكرار الفرصة في قاعدة البيانات المحلية (Duplicate Check)
	if (await db.hasLead(phone, sliemMsg.text)) {
		logger.info(`🚫 [${sessionId}] تم تجاهل طلب مكرر للطالب [${sliemMsg.pushName}]`)
		return
	}

	queue.add(async () => {
		logger.info(`🤖 [${sessionId}] جاري تمرير الرسالة عبر أنبوب SLIE المعياري...`)
		
		// 2. تشغيل الأنبوب المعياري بالكامل لـ SLIE (Engines 1-9)
		const pipelineResult = await runSLIEPipeline(sliemMsg)

		if (pipelineResult.decision === 'REJECT') {
			logger.info(`🚫 [${sessionId}] استبعاد SLIE: ${pipelineResult.analysis.reason}`)
			return
		}

		const analysis = pipelineResult.analysis
		let isLid = false
		let resolvedParticipantJid = participantJid
		let chatLink = ''

		// 3. فك معرف LID إذا كان مخفياً
		if (resolvedParticipantJid && resolvedParticipantJid.includes('@lid')) {
			try {
				const lidUser = resolvedParticipantJid.split('@')[0].split(':')[0]
				const stored = await sock.authState.keys.get('lid-mapping', [`${lidUser}_reverse`])
				const pnUser = stored?.[`${lidUser}_reverse`]
				if (pnUser && typeof pnUser === 'string') {
					resolvedParticipantJid = pnUser.includes('@') ? pnUser : `${pnUser}@s.whatsapp.net`
					logger.info(`✅ [${sessionId}] تم فك معرّف LID بنجاح إلى الرقم: ${resolvedParticipantJid}`)
				}
			} catch (err) {
				logger.warn(`⚠️ [${sessionId}] فشل فك معرّف LID: ${err}`)
			}
		}

		if (resolvedParticipantJid) {
			if (resolvedParticipantJid.includes('@lid')) {
				isLid = true
				chatLink = '🔒 (رقم مخفي بسبب إعدادات الخصوصية في مجتمعات واتساب)'
			} else {
				const resolvedPhone = resolvedParticipantJid.split('@')[0].split(':')[0]
				chatLink = `https://wa.me/${resolvedPhone}`
			}
		} else {
			chatLink = '⚠️ (تعذر استخراج رقم الهاتف)'
		}

		let originalGroup = 'مجموعة عامة'
		let groupLink = ''
		let groupJid = ''
		if (sliemMsg.remoteJid && sliemMsg.remoteJid.endsWith('@g.us')) {
			groupJid = sliemMsg.remoteJid.replace('@', ' [at] ')
			try {
				const meta = await sock.groupMetadata(sliemMsg.remoteJid)
				originalGroup = meta.subject || 'مجموعة عامة'
			} catch {
				originalGroup = 'مجموعة واتساب'
			}

			try {
				const code = await sock.groupInviteCode(sliemMsg.remoteJid)
				if (code) {
					groupLink = `https://chat.whatsapp.com/${code}`
				}
			} catch {
				// البوت ليس مشرفاً
			}
		}

		// 4. حفظ الفرصة في قاعدة البيانات المحلية (Persistence)
		const savedLead = await db.insertLead({
			studentPhone: phone || 'غير معروف',
			studentName: sliemMsg.pushName || 'غير مسجل',
			originalGroup,
			messageContent: sliemMsg.text,
			classification: analysis.classification,
			subject: analysis.subject,
			score: analysis.leadScore,
			confidence: analysis.confidence
		})

		// 5. صياغة الرسالة التنبيهية التلقائية المبسطة المنسقة كما طلب المستخدم باستخدام الأيقونات فقط
		const leads = await db.getLeads()
		const leadCount = leads.filter(l => l.subject !== 'رابط مجموعة').length
		const nextLeadNumber = leadCount + 1

		const alertMessage = `📝 *#${nextLeadNumber}*

💬 ${sliemMsg.text}${sliemMsg.quotedText ? `\n*(الرد على):* "${sliemMsg.quotedText}"` : ''}

👤 ${chatLink}

${groupLink ? `👥 ${groupLink}` : ''}`

		const sleepTime = Math.floor(Math.random() * 3000) + 2000
		await new Promise(resolve => setTimeout(resolve, sleepTime))

		// جلب مقبس الإرسال المخصص
		const configuredSenderSock = activeSockets.get(senderSessionId)
		if (!configuredSenderSock && isReadOnlySession(sessionId)) {
			logger.warn(`⏸️ [${sessionId}] الحساب للقراءة فقط والمرسل [${senderSessionId}] غير متصل — تم إلغاء إرسال التنبيه`)
			return
		}
		const senderSock = configuredSenderSock || sock

		try {
			const sent = await senderSock.sendMessage(leadsGroupJid, { text: alertMessage })
			if (sent?.key?.id) {
				// ربط معرف رسالة التنبيه بالـ Lead للاستماع للتغذية الراجعة
				await db.updateLeadSentMessageId(savedLead.id, sent.key.id)
			}
			logger.info(`✅ [${sessionId}] تم توجيه الـ Lead بنجاح بالمعرف: ${savedLead.id} عبر [${senderSessionId}]`)
		} catch (err) {
			logger.error(`❌ [${sessionId}] فشل إرسال تنبيه الطالب عبر [${senderSessionId}]: ${err}`)
		}
	})
}

/**
 * معالجة تفاعلات المشرفين بالرموز (👍 أو 👎) للتصحيح والتعلم الذاتي
 */
async function handleModeratorReaction(sock: any, sessionId: string, sentMessageId: string, emoji: string) {
	try {
		if (isReadOnlySession(sessionId)) {
			logger.info(`⏭️ [${sessionId}] تجاهل الرد على التفاعل لأن الحساب للقراءة فقط`)
			return
		}
		const isTrueHelp = emoji === '👍' || emoji === '✅'
		const isFalseAd = emoji === '👎' || emoji === '❌'

		if (!isTrueHelp && !isFalseAd) return // تجاهل الرموز الأخرى

		const { db } = await import('../database/database')
		const { processModeratorFeedback } = await import('../slie')
		const leads = await db.getLeads()
		const lead = leads.find(l => l.sentMessageId === sentMessageId)

		if (!lead) {
			logger.warn(`⚠️ [${sessionId}] لم يتم العثور على Lead مطابق لمعرف الرسالة التفاعلية: ${sentMessageId}`)
			return
		}

		logger.info(`🔄 [${sessionId}] جاري معالجة التغذية الراجعة للمشرف (الرمز: ${emoji}) للمعرف: ${lead.id}...`)
		await processModeratorFeedback(lead.studentPhone, lead.messageContent, isTrueHelp)

		// إرسال رد تأكيدي بسيط تحت التنبيه لتأكيد التعلم
		const leadsGroupJid = sessionLeadsGroupJids.get(sessionId)
		if (leadsGroupJid) {
			const replyText = isTrueHelp 
				? `✅ تم تأكيد الفرصة كـ طالب حقيقي! رفع مستوى ثقة سلوك هذا المستخدم في النظام.` 
				: `❌ تم تصنيف الرسالة كـ إعلان كاذب! خصم معامل ثقة المرسل وتحديث فلاتر القواعد تلقائياً.`

			await sock.sendMessage(leadsGroupJid, { 
				text: replyText 
			}, { 
				quoted: {
					key: {
						remoteJid: leadsGroupJid,
						id: sentMessageId,
						fromMe: true
					},
					message: {
						conversation: lead.messageContent
					}
				}
			})
		}
	} catch (err) {
		logger.error(`❌ [${sessionId}] فشل معالجة التغذية الراجعة للمشرف: ${err}`)
	}
}
