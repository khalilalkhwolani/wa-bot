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
import { db } from '../database/database'
import { 
	runSLIEPipeline, 
	contextBuilder, 
	processModeratorFeedback, 
	SLIEMessage 
} from '../slie'

// إعداد السجلات بنفس الهيئة النظيفة
const logger = P({
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

// وقت تشغيل البوت لتفادي معالجة الرسائل القديمة المؤرشفة
const botStartupTime = Date.now()

// خرائط طوابير الإرسال (Session ID -> PQueue)
const sessionLinksQueues = new Map<string, PQueue>()
const sessionLeadsQueues = new Map<string, PQueue>()

/** منع تشغيل/إعادة اتصال مزدوج لنفس الحساب */
const startingSessions = new Set<string>()
const reconnectScheduled = new Set<string>()

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
	const linksQueue = new PQueue({ concurrency: 1 })
	const leadsQueue = new PQueue({ concurrency: 1 })
	sessionLinksQueues.set(sessionId, linksQueue)
	sessionLeadsQueues.set(sessionId, leadsQueue)

	const authFolder = path.join('sessions', `auth_info_${sessionId}`)
	const { state, saveCreds } = await useMultiFileAuthState(authFolder)
	const { version } = await fetchLatestBaileysVersion()

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

	// التعامل مع تحديثات الاتصال وإعادة الاتصال الذكية
	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, qr } = update

		if (qr) {
			logger.info(`📸 يرجى مسح رمز الـ QR التالي للاتصال بالحساب [${sessionId}]:`)
			qrcode.generate(qr, { small: true })
		}

		if (connection === 'close') {
			activeSockets.delete(sessionId)
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
			logger.info(`✅ تم فتح الاتصال بنجاح للحساب [${sessionId}]!`)
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

				// استخدام محرك تجميع السياق (Context Builder) المطور للرسائل المتتالية
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

	const queue = sessionLinksQueues.get(sessionId)
	if (!queue) return

	queue.add(async () => {
		const cleanLinks = links.map(l => l.link)
		if (cleanLinks.length === 0) return

		// منع التكرار — لكن فقط للروابط التي أُرسلت فعلاً من قبل
		if (await db.hasLinkBeenSent(cleanLinks[0])) {
			logger.info(`⏭️ [${sessionId}] رابط مكرر (مُرسل سابقاً) تم تجاهله: ${cleanLinks[0]}`)
			return
		}

		const rawParticipant = msg.key.participantAlt || msg.key.participant || msg.key.remoteJid || ''
		const linkPhone = rawParticipant.split('@')[0].split(':')[0] || 'غير معروف'

		// 1. حساب رقم التسلسل للرابط الجديد
		const leads = await db.getLeads()
		const linkCount = leads.filter(l => l.subject === 'رابط مجموعة').length
		const nextNumber = linkCount + 1

		// 2. تحديد اسم المجموعة المصدر
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

		// 3. تنسيق الرسالة بنفس الشكل المطلوب في الصورة
		const alertMessage = `🔗 *رابط واتساب جديد #${nextNumber}*
*المصدر:* ${groupName}
${cleanLinks.join('\n')}`

		// انتظر المرسل إن كان يعيد الاتصال (يمنع خطأ attrs عند انقطاع 408)
		let senderSock = activeSockets.get(senderSessionId)
		if (!senderSock && senderSessionId !== sessionId) {
			for (let i = 0; i < 6 && !senderSock; i++) {
				await new Promise(r => setTimeout(r, 2000))
				senderSock = activeSockets.get(senderSessionId)
			}
		}
		senderSock = senderSock || sock
		const usedSender = activeSockets.get(senderSessionId) ? senderSessionId : `${sessionId}(fallback)`

		logger.info(`📤 [${sessionId}] محاولة إرسال رابط إلى JID=${linksGroupJid} عبر [${usedSender}]`)

		try {
			// تعطيل معاينة الرابط: واتساب أحياناً يقبل الإرسال ثم يحجب ظهور روابط المجموعات مع الـ preview
			const sent = await senderSock.sendMessage(
				linksGroupJid,
				{ text: alertMessage },
				{ linkPreview: false }
			)

			if (!sent?.key?.id) {
				logger.error(`❌ [${sessionId}] الإرسال رجع بدون معرف رسالة — الرسالة غالباً لم تصل. الوجهة: ${linksGroupJid}`)
				return
			}

			// نحفظ في القاعدة فقط بعد نجاح الإرسال الحقيقي حتى لا نمنع إعادة المحاولة
			await db.insertLead({
				studentPhone: linkPhone,
				studentName: msg.pushName || 'غير مسجل',
				originalGroup: groupName,
				messageContent: cleanLinks[0],
				classification: 'DISCUSSION',
				subject: 'رابط مجموعة',
				score: 50,
				confidence: 0.8
			})

			logger.info(`✅ [${sessionId}] وصل الإرسال: msgId=${sent.key.id} | الوجهة=${linksGroupJid} | عبر=${usedSender}`)
		} catch (err) {
			logger.error(`❌ [${sessionId}] فشل إرسال الرابط إلى ${linksGroupJid} عبر [${usedSender}]: ${err}`)
		}
	})
}

/**
 * معالجة طلبات مساعدة الطلاب عبر أنبوب SLIE المعياري
 */
async function handleStudentLeadMessage(sock: any, sessionId: string, sliemMsg: SLIEMessage) {
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
		const senderSock = activeSockets.get(senderSessionId) || sock

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
		const isTrueHelp = emoji === '👍' || emoji === '✅'
		const isFalseAd = emoji === '👎' || emoji === '❌'

		if (!isTrueHelp && !isFalseAd) return // تجاهل الرموز الأخرى

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
