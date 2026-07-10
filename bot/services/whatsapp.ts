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
			const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
			logger.error(`❌ انقطع الاتصال للحساب [${sessionId}]. السبب: ${lastDisconnect?.error}`)
			
			if (shouldReconnect) {
				logger.info(`🔄 جاري محاولة إعادة الاتصال خلال 5 ثوانٍ للحساب [${sessionId}]...`)
				setTimeout(() => startWhatsAppSession(sessionId), 5000)
			} else {
				logger.error(`⚠️ تم تسجيل الخروج للحساب [${sessionId}]. يرجى إزالة المجلد ${authFolder} وإعادة التشغيل.`)
			}
		} else if (connection === 'open') {
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

				// استخدام محرك تجميع السياق (Context Builder) لدمج الرسائل المتتالية للمرسل خلال 10 ثوانٍ
				contextBuilder.addMessage(sliemMsg, (combinedMsg) => {
					handleStudentLeadMessage(sock, sessionId, combinedMsg)
				})
			}
		}
	})
}

/**
 * البحث عن معرفات المجموعات المستهدفة عند الاتصال
 */
async function lookupGroupJids(sock: any, sessionId: string) {
	try {
		logger.info(`🔍 جاري البحث عن المجموعات المستهدفة للحساب [${sessionId}]...`)
		const groups = await sock.groupFetchAllParticipating()

		const linksNorm = normalizeArabic(config.TARGET_LINKS_GROUP)
		const leadsNorm = normalizeArabic(config.TARGET_LEADS_GROUP)

		for (const jid in groups) {
			const subject = groups[jid].subject
			const subjectNorm = normalizeArabic(subject)

			if (subject === config.TARGET_LINKS_GROUP || subjectNorm === linksNorm) {
				sessionLinksGroupJids.set(sessionId, jid)
				logger.info(`✅ تم العثور على مجموعة الروابط: "${subject}" بالمعرف: ${jid}`)
			}
			if (subject === config.TARGET_LEADS_GROUP || subjectNorm === leadsNorm) {
				sessionLeadsGroupJids.set(sessionId, jid)
				logger.info(`✅ تم العثور على مجموعة الطلاب: "${subject}" بالمعرف: ${jid}`)
			}
		}
	} catch (err) {
		logger.error(`❌ فشل جلب المجموعات للحساب [${sessionId}]: ${err}`)
	}
}

/**
 * معالجة وتصفية وتوجيه روابط المجموعات
 */
async function handleGroupLinks(sock: any, sessionId: string, msg: any, text: string, links: { link: string; code: string }[]) {
	const linksGroupJid = sessionLinksGroupJids.get(sessionId)
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

		// منع إرسال نفس الرابط المكرر في نفس المجموعة
		const linkPhone = (msg.key.participantAlt || msg.key.participant || msg.key.remoteJid || '').split('@')[0].split(':')[0]
		if (await db.hasLead(linkPhone, cleanLinks[0])) {
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

		try {
			await sock.sendMessage(linksGroupJid, { text: alertMessage })
			logger.info(`✅ [${sessionId}] تم توجيه الرابط بنجاح لمجموعة العمل.`)
		} catch (err) {
			logger.error(`❌ [${sessionId}] فشل توجيه الرابط لمجموعة العمل: ${err}`)
		}
	})
}

/**
 * معالجة طلبات مساعدة الطلاب عبر أنبوب SLIE المعياري
 */
async function handleStudentLeadMessage(sock: any, sessionId: string, sliemMsg: SLIEMessage) {
	const leadsGroupJid = sessionLeadsGroupJids.get(sessionId)
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
		let groupDeepLink = ''
		if (sliemMsg.remoteJid && sliemMsg.remoteJid.endsWith('@g.us')) {
			groupDeepLink = `whatsapp://chat?jid=${sliemMsg.remoteJid}`
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
"${sliemMsg.text}"
${sliemMsg.quotedText ? `\n💬 *رد على رسالة:* "${sliemMsg.quotedText}"` : ''}

${groupLink ? `👥 *رابط المجموعة المصدر:* ${groupLink}\n` : ''}${groupDeepLink ? `📱 *رابط الانتقال السريع للمجموعة:* ${groupDeepLink}\n` : ''}
🔗 *رابط التواصل المباشر مع الطالب:*
${chatLink}`

		const sleepTime = Math.floor(Math.random() * 3000) + 2000
		await new Promise(resolve => setTimeout(resolve, sleepTime))

		try {
			const sent = await sock.sendMessage(leadsGroupJid, { text: alertMessage })
			if (sent?.key?.id) {
				// ربط معرف رسالة التنبيه بالـ Lead للاستماع للتغذية الراجعة
				await db.updateLeadSentMessageId(savedLead.id, sent.key.id)
			}
			logger.info(`✅ [${sessionId}] تم توجيه الـ Lead بنجاح بالمعرف: ${savedLead.id}`)
		} catch (err) {
			logger.error(`❌ [${sessionId}] فشل إرسال تنبيه الطالب: ${err}`)
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
