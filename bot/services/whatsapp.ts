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
import { isSpamLinkText } from './ruleEngine'
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

// خريطة لتخزين اتصالات الجلسات النشطة لمشاركتها (Session ID -> socket)
export const activeSockets = new Map<string, any>()

// وقت تشغيل البوت لتفادي معالجة الرسائل القديمة المؤرشفة
const botStartupTime = Date.now()

// خرائط طوابير الإرسال (Session ID -> PQueue)
const sessionLinksQueues = new Map<string, PQueue>()
const sessionLeadsQueues = new Map<string, PQueue>()

/**
 * دالة لتشغيل وإدارة جلسة عمل واتساب
 */
export async function startWhatsAppSession(sessionId: string) {
	logger.info(`🔌 جاري تهيئة الاتصال للحساب: [${sessionId}]...`)

	// إنشاء طوابير إرسال مستقلة
	const linksQueue = new PQueue({ concurrency: 1 })
	const leadsQueue = new PQueue({ concurrency: 1 })
	sessionLinksQueues.set(sessionId, linksQueue)
	sessionLeadsQueues.set(sessionId, leadsQueue)

	const authFolder = path.join('sessions', `auth_info_${sessionId}`)
	const { state, saveCreds } = await useMultiFileAuthState(authFolder)
	const { version } = await fetchLatestBaileysVersion()

	const sock = makeWASocket({
		version,
		logger: P({ level: 'silent' }),
		printQRInTerminal: true,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		generateHighQualityLinkPreview: true,
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
			activeSockets.delete(sessionId) // إزالة المقبس عند إغلاق الاتصال
			const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
			logger.error(`❌ انقطع الاتصال للحساب [${sessionId}]. السبب: ${lastDisconnect?.error}`)
			
			if (shouldReconnect) {
				logger.info(`🔄 جاري محاولة إعادة الاتصال خلال 5 ثوانٍ للحساب [${sessionId}]...`)
				setTimeout(() => startWhatsAppSession(sessionId), 5000)
			} else {
				logger.error(`⚠️ تم تسجيل الخروج للحساب [${sessionId}]. يرجى إزالة المجلد ${authFolder} وإعادة التشغيل.`)
			}
		} else if (connection === 'open') {
			activeSockets.set(sessionId, sock) // حفظ المقبس عند نجاح الاتصال
			logger.info(`✅ تم فتح الاتصال بنجاح للحساب [${sessionId}]!`)
			await lookupGroupJids(sock, sessionId)
		}
	})

	// مراقبة الرسائل الواردة وتوجيهها للمحركات المناسبة
	sock.ev.on('messages.upsert', async (upsert) => {
		if (upsert.type !== 'notify') return

		for (const msg of upsert.messages) {
			if (msg.key.fromMe) continue
			if (msg.key.remoteJid && isJidNewsletter(msg.key.remoteJid)) continue

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
				if (leadsGroupJid && targetKey.remoteJid === leadsGroupJid) {
					await handleModeratorReaction(sock, sessionId, targetKey.id || '', emoji)
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

			// 2. معالجة الروابط المجمعة (Links Forwarding)
			if (text) {
				const localLinksRegex = /https:\/\/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9]+)/gi
				const links: { link: string; code: string }[] = []
				let match
				while ((match = localLinksRegex.exec(text)) !== null) {
					links.push({ link: match[0], code: match[1] })
				}

				if (links.length > 0) {
					handleGroupLinks(sock, sessionId, msg, text, links)
				}
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
}

/**
 * البحث عن معرفات المجموعات المستهدفة عند الاتصال وتعيينها بدقة
 */
async function lookupGroupJids(sock: any, sessionId: string) {
	try {
		logger.info(`🔍 جاري جلب كافة المجموعات التي يشارك فيها الحساب [${sessionId}]...`)
		const groups = await sock.groupFetchAllParticipating()

		// 1. طباعة قائمة بكافة المجموعات ومعرفاتها الفريدة في السجلات
		console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
		console.log(`📋 المجموعات النشطة للحساب [${sessionId}]:`)
		for (const jid in groups) {
			console.log(`   - الاسم: "${groups[jid].subject}" | المعرّف (JID): ${jid}`)
		}
		console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

		// 2. التحقق من التعيين المباشر عبر معرفات JIDs الفريدة
		if (config.TARGET_LINKS_GROUP && config.TARGET_LINKS_GROUP.endsWith('@g.us')) {
			sessionLinksGroupJids.set(sessionId, config.TARGET_LINKS_GROUP)
			logger.info(`🎯 تم تعيين مجموعة الروابط مباشرة بالمعرف الفريد (JID): ${config.TARGET_LINKS_GROUP}`)
		}
		if (config.TARGET_LEADS_GROUP && config.TARGET_LEADS_GROUP.endsWith('@g.us')) {
			sessionLeadsGroupJids.set(sessionId, config.TARGET_LEADS_GROUP)
			logger.info(`🎯 تم تعيين مجموعة الطلاب مباشرة بالمعرف الفريد (JID): ${config.TARGET_LEADS_GROUP}`)
		}

		// 3. البحث البديل بالاسم (في حال لم تكن الإعدادات JIDs)
		const linksNorm = normalizeArabic(config.TARGET_LINKS_GROUP)
		const leadsNorm = normalizeArabic(config.TARGET_LEADS_GROUP)

		for (const jid in groups) {
			const subject = groups[jid].subject
			const subjectNorm = normalizeArabic(subject)

			// تعيين مجموعة الروابط بالاسم فقط إذا لم تكن معينة مسبقاً بـ JID
			if (!sessionLinksGroupJids.has(sessionId)) {
				if (subject === config.TARGET_LINKS_GROUP || subjectNorm === linksNorm) {
					sessionLinksGroupJids.set(sessionId, jid)
					logger.info(`✅ تم العثور على مجموعة الروابط بالاسم: "${subject}" بالمعرف: ${jid}`)
				}
			}

			// تعيين مجموعة الطلاب بالاسم فقط إذا لم تكن معينة مسبقاً بـ JID
			if (!sessionLeadsGroupJids.has(sessionId)) {
				if (subject === config.TARGET_LEADS_GROUP || subjectNorm === leadsNorm) {
					sessionLeadsGroupJids.set(sessionId, jid)
					logger.info(`✅ تم العثور على مجموعة الطلاب بالاسم: "${subject}" بالمعرف: ${jid}`)
				}
			}
		}

		// تحذير في حال عدم العثور على المجموعات المستهدفة
		if (!sessionLinksGroupJids.has(sessionId)) {
			logger.warn(`⚠️ لم يتم تحديد مجموعة الروابط المستهدفة [${config.TARGET_LINKS_GROUP}] للحساب [${sessionId}]`)
		}
		if (!sessionLeadsGroupJids.has(sessionId)) {
			logger.warn(`⚠️ لم يتم تحديد مجموعة الطلاب المستهدفة [${config.TARGET_LEADS_GROUP}] للحساب [${sessionId}]`)
		}
	} catch (err) {
		logger.error(`❌ فشل جلب المجموعات للحساب [${sessionId}]: ${err}`)
	}
}

/**
 * معالجة وتصفية وتوجيه روابط المجموعات
 */
async function handleGroupLinks(sock: any, sessionId: string, msg: any, text: string, links: { link: string; code: string }[]) {
	const senderSessionId = (config as any).SENDER_SESSION || sessionId
	const linksGroupJid = sessionLinksGroupJids.get(senderSessionId)
	if (!linksGroupJid) return

	const queue = sessionLinksQueues.get(sessionId)
	if (!queue) return

	queue.add(async () => {
		const cleanLinks: string[] = []

		for (const linkObj of links) {
			const linkTextToCheck = `${linkObj.link} ${text}`
			if (!isSpamLinkText(linkTextToCheck)) {
				cleanLinks.push(linkObj.link)
			}
		}

		if (cleanLinks.length === 0) return

		// منع إرسال نفس الرابط المكرر على الإطلاق (تجنب التكرار العالمي للرابط نفسه)
		if (await db.hasLinkBeenSent(cleanLinks[0])) {
			return
		}

		// حفظ الرابط كفرصة لتجنب التكرار
		await db.insertLead({
			studentPhone: linkPhone,
			studentName: msg.pushName || 'غير مسجل',
			originalGroup: 'روابط مجموعات',
			messageContent: cleanLinks[0],
			classification: 'DISCUSSION',
			subject: 'رابط مجموعة',
			score: 50,
			confidence: 0.8
		})

		const alertMessage = `🔗 *رابط مجموعة واتساب للعمل:*
${cleanLinks.join('\n')}`

		// جلب مقبس الإرسال المخصص
		const senderSock = activeSockets.get(senderSessionId) || sock

		try {
			await senderSock.sendMessage(linksGroupJid, { text: alertMessage })
			logger.info(`✅ [${sessionId}] تم توجيه الرابط بنجاح لمجموعة العمل عبر [${senderSessionId}].`)
		} catch (err) {
			logger.error(`❌ [${sessionId}] فشل توجيه الرابط لمجموعة العمل عبر [${senderSessionId}]: ${err}`)
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

		// 5. صياغة الرسالة التنبيهية التلقائية المبسطة
		const alertMessage = `📝 *طلب مساعدة جديد (Lead)*

👥 *المجموعة المصدر:* ${savedLead.originalGroup}
👤 *الطالب:* ${savedLead.studentName} ${isLid ? `(🔒 رقم مخفي)` : `(@${savedLead.studentPhone})`}

💬 *الرسالة الأصلية:*
${sliemMsg.text}
${sliemMsg.quotedText ? `\n↪️ *الرسالة المقتبسة (التي تم الرد عليها):* "${sliemMsg.quotedText}"` : ''}

${groupLink ? `👥 *رابط المجموعة المصدر:* ${groupLink}\n` : ''}${groupJid ? `🆔 *معرف المجموعة:* \`${groupJid}\`\n` : ''}
🔗 *رابط التواصل المباشر مع الطالب:*
${chatLink}`

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
