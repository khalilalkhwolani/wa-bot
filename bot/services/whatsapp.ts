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
import { shouldAnalyzeStudentLead, isSpamLinkText } from './ruleEngine'
import { analyzeMessageWithAI } from './gemini'
import { evaluateLead } from './scorer'
import { db } from '../database/database'

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
		logger,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		printQRInTerminal: false,
		syncFullHistory: false,
	})

	sock.ev.on('creds.update', saveCreds)

	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, qr } = update

		if (qr) {
			logger.info(`--------------------------------------------------`)
			logger.info(`يرجى مسح الرمز المربع (QR Code) لتسجيل دخول الحساب [${sessionId}]:`)
			logger.info(`--------------------------------------------------`)
			qrcode.generate(qr, { small: true })
		}

		if (connection === 'close') {
			const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
			logger.error(`❌ انقطع الاتصال للحساب [${sessionId}]. السبب: ${lastDisconnect?.error}`)
			if (shouldReconnect) {
				logger.info(`🔄 جاري إعادة الاتصال للحساب [${sessionId}] في غضون 5 ثوانٍ...`)
				setTimeout(() => startWhatsAppSession(sessionId), 5000)
			} else {
				logger.fatal(`🚨 تم تسجيل الخروج للحساب [${sessionId}]. يرجى مسح المجلد "${authFolder}" وإعادة التشغيل.`)
			}
		}

		if (connection === 'open') {
			logger.info(`🎉 تم تسجيل الدخول بنجاح للحساب [${sessionId}]!`)
			await lookupGroupJids(sock, sessionId)
		}
	})

	// مراقبة الرسائل الواردة وتوجيهها للمحركات المناسبة
	sock.ev.on('messages.upsert', async (upsert) => {
		if (upsert.type !== 'notify') return

		for (const msg of upsert.messages) {
			if (msg.key.fromMe) continue
			if (msg.key.remoteJid && isJidNewsletter(msg.key.remoteJid)) continue

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

			// 1. معالجة الروابط المجمعة (Links Forwarding)
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

			// 2. معالجة طلبات مساعدة الطلاب (Student Leads)
			if (text || quotedText) {
				handleStudentLeadMessage(sock, sessionId, msg, text, quotedText)
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

			if (subject === config.TARGET_LINKS_GROUP || subjectNorm === linksNorm || subjectNorm.includes('العمل')) {
				sessionLinksGroupJids.set(sessionId, jid)
				logger.info(`✅ تم العثور على مجموعة الروابط: "${subject}" بالمعرف: ${jid}`)
			}
			if (subject === config.TARGET_LEADS_GROUP || subjectNorm === leadsNorm || subjectNorm.includes('طلاب') || subjectNorm.includes('طلب')) {
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

		for (const item of links) {
			// فحص نص الرسالة الأصلي
			if (isSpamLinkText(text)) {
				logger.info(`🚫 [${sessionId}] حظر رابط (${item.link}) لاحتواء النص على كلمات محظورة.`)
				continue
			}

			// فحص تفاصيل المجموعة عن بعد دون انضمام
			try {
				const info = await sock.groupGetInviteInfo(item.code)
				if (info && (isSpamLinkText(info.subject) || (info.desc && isSpamLinkText(info.desc)))) {
					logger.info(`🚫 [${sessionId}] حظر رابط مجموعة سبام/إعلانية: "${info.subject}"`)
					continue
				}
			} catch (err) {
				logger.warn(`⚠️ [${sessionId}] تعذر فحص معلومات الرابط (${item.code}) عبر السيرفر: ${err}. سيتم تمريره كاحتياط.`)
			}

			cleanLinks.push(item.link)
		}

		if (cleanLinks.length > 0) {
			const combined = cleanLinks.join('\n')
			const sleepTime = Math.floor(Math.random() * 4000) + 4000
			await new Promise(resolve => setTimeout(resolve, sleepTime))

			try {
				await sock.sendMessage(linksGroupJid, { text: combined })
				logger.info(`✅ [${sessionId}] تم توجيه الروابط المجمعة النظيفة:\n${combined}`)
			} catch (err) {
				logger.error(`❌ [${sessionId}] فشل توجيه الروابط: ${err}`)
			}
		}
	})
}

/**
 * معالجة وتصنيف وتوجيه طلبات مساعدة الطلاب
 */
async function handleStudentLeadMessage(sock: any, sessionId: string, msg: any, text: string, quotedText: string) {
	// 1. تشغيل الفلتر السريع (Rule Engine) محلياً
	if (!shouldAnalyzeStudentLead(text) && (!quotedText || !shouldAnalyzeStudentLead(quotedText))) {
		return
	}

	const leadsGroupJid = sessionLeadsGroupJids.get(sessionId)
	if (!leadsGroupJid) return

	const queue = sessionLeadsQueues.get(sessionId)
	if (!queue) return

	// 2. التحقق من عدم تكرار الفرصة في قاعدة البيانات المحلية (Duplicate Check)
	if (await db.hasLead(text)) {
		logger.info(`🚫 [${sessionId}] تم تجاهل طلب مكرر للطالب [${msg.pushName}]`)
		return
	}

	queue.add(async () => {
		logger.info(`🤖 [${sessionId}] جاري فحص الرسالة عبر الذكاء الاصطناعي...`)
		
		// 3. التحليل بواسطة Gemini AI
		const analysis = await analyzeMessageWithAI(text, quotedText)

		// 4. تقييم الفرصة وحساب النقاط
		const evaluation = evaluateLead(analysis)
		if (!evaluation.shouldNotify) {
			logger.info(`🚫 [${sessionId}] استبعاد: ${evaluation.reason}`)
			return
		}

		// استخراج بيانات الطالب والمجموعة الأصلية
		const participantJid = msg.key.participant || msg.key.remoteJid || ''
		const phone = participantJid.split('@')[0]
		const chatLink = `https://wa.me/${phone}`

		let originalGroup = 'مجموعة عامة'
		if (msg.key.remoteJid && msg.key.remoteJid.endsWith('@g.us')) {
			try {
				const meta = await sock.groupMetadata(msg.key.remoteJid)
				originalGroup = meta.subject || 'مجموعة عامة'
			} catch {
				originalGroup = 'مجموعة واتساب'
			}
		}

		// 5. حفظ الفرصة في قاعدة البيانات المحلية (Persistence)
		const savedLead = await db.insertLead({
			studentPhone: phone,
			studentName: msg.pushName || 'غير مسجل',
			originalGroup,
			messageContent: text,
			classification: analysis.classification,
			subject: analysis.subject,
			score: analysis.leadScore,
			confidence: analysis.confidence
		})

		// صياغة الرسالة التنبيهية
		const alertMessage = `🚨 *طلب مساعدة من طالب (Lead)*

👤 *الطالب:* ${savedLead.studentName} (@${savedLead.studentPhone})
👥 *المجموعة المصدر:* ${savedLead.originalGroup}
📚 *المادة:* ${savedLead.subject}
🗂️ *التصنيف:* ${analysis.category || 'غير محدد'}
🔥 *الأهمية:* ${analysis.urgency === 'High' ? '🔴 عالية جداً' : analysis.urgency === 'Medium' ? '🟡 متوسطة' : '⚪ منخفضة'}
💡 *التحليل:* ${analysis.reason}
📈 *درجة الجودة:* ${savedLead.score}/100 (ثقة الـ AI: ${savedLead.confidence})
🆔 *معرف الطلب:* ${savedLead.id}

💬 *الرسالة الأصلية:*
"${text}"
${quotedText ? `\n💬 *رد على رسالة:* "${quotedText}"` : ''}

🔗 *رابط التواصل المباشر مع الطالب:*
${chatLink}`

		const sleepTime = Math.floor(Math.random() * 3000) + 2000
		await new Promise(resolve => setTimeout(resolve, sleepTime))

		try {
			await sock.sendMessage(leadsGroupJid, { text: alertMessage })
			logger.info(`✅ [${sessionId}] تم توجيه الـ Lead بنجاح بالمعرف: ${savedLead.id}`)
		} catch (err) {
			logger.error(`❌ [${sessionId}] فشل إرسال تنبيه الطالب: ${err}`)
		}
	})
}
