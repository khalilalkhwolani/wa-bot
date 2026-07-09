import { Boom } from '@hapi/boom'
import makeWASocket, { 
	DisconnectReason, 
	fetchLatestBaileysVersion, 
	isJidNewsletter, 
	makeCacheableSignalKeyStore, 
	useMultiFileAuthState 
} from '../src'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import fs from 'fs'
import path from 'path'
import PQueue from 'p-queue'
import http from 'http'
import { handleStudentLeads } from './student_leads'

// إعداد مستوى سجلات Pino ليكون نظيفاً ومقروءاً في الكونسول
const logger = P({
	level: 'info',
	transport: {
		target: 'pino-pretty',
		options: { colorize: true }
	}
})

// اسم المجموعة المستهدفة لإرسال الروابط إليها
const TARGET_GROUP_NAME = 'العمل'

// دالة مساعدة لتسهيل مطابقة أسماء المجموعات باللغة العربية (تتغاضى عن الهاء والتاء المربوطة والمسافات)
function normalizeArabic(text: string): string {
	if (!text) return ''
	return text
		.replace(/ة/g, 'ه')
		.replace(/\s+/g, '')
		.trim()
}

// دالة لتطبيع النصوص العربية للبحث والمطابقة الدقيقة للكلمات المحظورة
function normalizeArabicSearch(text: string): string {
	if (!text) return ''
	return text
		.toLowerCase()
		.replace(/[أإآ]/g, 'ا')
		.replace(/ة/g, 'ه')
		.replace(/ى/g, 'ي')
		.trim()
}

// الكلمات المفتاحية المحظورة (تشمل: إجازات مرضية، حل واجبات واختبارات، خدمات عامة وإعلانات سبام)
const BLACKLIST_KEYWORDS = [
	'سكليف', 'غياب', 'اجازه', 'مرضيه', 'طبي', 'اعذار', 'غيابات', 
	'اجازات', 'مستشفي', 'مرضي', 'اعلان', 'إعلان', 'اعلانات', 'إعلانات',
	'تبرير', 'تقرير', 'تقارير', 'طبيب', 'عذر', 'عياده', 'صحي',
	'حل', 'اختبار', 'اختبارات', 'امتحان', 'امتحانات', 'واجب', 'واجبات', 
	'اسايمنت', 'بحوث', 'بحث', 'بروجكت', 'مشاريع', 'تلخيص', 'ملخصات', 
	'تفريغ', 'جواز', 'جوازات', 'جوازين', 'نقل معلومات', 'انجاز'
].map(normalizeArabicSearch)

// دالة تفحص ما إذا كان النص يحتوي على أي من الكلمات المحظورة (سبام)
function isSpam(text: string): boolean {
	if (!text) return false
	const normalizedText = normalizeArabicSearch(text)
	return BLACKLIST_KEYWORDS.some(keyword => normalizedText.includes(keyword))
}

// قائمة الحسابات النشطة (يمكنك إضافة حسابات أخرى هنا لتشغيلها معاً)
const SESSIONS = ['account_1']

// تعبير نمطي للبحث عن روابط مجموعات واتساب واستخراج كود الدعوة منها
const groupLinkRegex = /https:\/\/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9]+)/gi

// خريطة لتخزين معرفات المجموعات لكل حساب (Session ID -> Group JID)
const sessionGroupJids = new Map<string, string>()

// خريطة لتخزين طوابير الإرسال لكل حساب لمنع التداخل (Session ID -> PQueue)
const sessionQueues = new Map<string, PQueue>()

/**
 * دالة لتشغيل حساب واتساب محدد
 */
async function startSession(sessionId: string) {
	logger.info(`جاري تشغيل الحساب: [${sessionId}]...`)

	// إنشاء طابور إرسال مستقل لكل حساب لضمان المعالجة المتتالية والآمنة
	const queue = new PQueue({ concurrency: 1 })
	sessionQueues.set(sessionId, queue)

	// تحديد مسار مجلد حفظ الجلسة لكل حساب بشكل مستقل
	const authFolder = path.join('sessions', `auth_info_${sessionId}`)
	const { state, saveCreds } = await useMultiFileAuthState(authFolder)

	// جلب أحدث إصدار من واتساب ويب
	const { version } = await fetchLatestBaileysVersion()

	// إنشاء اتصال الواتساب الخاص بالجلسة
	const sock = makeWASocket({
		version,
		logger,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		// إعدادات إضافية لتحسين الأداء واستقبال الرسائل واستقرار الجلسة
		printQRInTerminal: false, // سنقوم بطباعته يدوياً بشكل أفضل
		syncFullHistory: false, // لتعطيل المزامنة الكاملة للسجل وتجنب ضغط العمليات ومشاكل الفصل
	})

	// حفظ الجلسة عند التحديث
	sock.ev.on('creds.update', saveCreds)

	// مراقبة تحديثات الاتصال (مثل ظهور QR code، فشل الاتصال، أو نجاحه)
	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, qr } = update

		if (qr) {
			logger.info(`--------------------------------------------------`)
			logger.info(`يرجى مسح الرمز المربع (QR Code) لتسجيل دخول الحساب [${sessionId}]:`)
			logger.info(`--------------------------------------------------`)
			// طباعة الـ QR Code في الكونسول بشكل رسومي ليسهل مسحه بالهاتف
			qrcode.generate(qr, { small: true })
		}

		if (connection === 'close') {
			const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
			logger.error(`انقطع الاتصال للحساب [${sessionId}]. السبب: ${lastDisconnect?.error}`)
			if (shouldReconnect) {
				logger.info(`إعادة الاتصال للحساب [${sessionId}]...`)
				startSession(sessionId)
			} else {
				logger.fatal(`تم تسجيل الخروج للحساب [${sessionId}]. يرجى حذف المجلد "${authFolder}" وإعادة التشغيل للمسح مجدداً.`)
			}
		}

		if (connection === 'open') {
			logger.info(`🎉 تم تسجيل الدخول بنجاح للحساب [${sessionId}]!`)

			// البحث عن المجموعة المستهدفة
			try {
				logger.info(`جاري البحث عن مجموعة باسم "${TARGET_GROUP_NAME}" للحساب [${sessionId}]...`)
				const groups = await sock.groupFetchAllParticipating()
				let foundJid = ''

				const targetNormalized = normalizeArabic(TARGET_GROUP_NAME)
				for (const jid in groups) {
					const subject = groups[jid].subject
					const subjectNormalized = normalizeArabic(subject)
					
					if (subject === TARGET_GROUP_NAME || subjectNormalized === targetNormalized || subjectNormalized.includes('العمل')) {
						foundJid = jid
						break
					}
				}

				if (foundJid) {
					sessionGroupJids.set(sessionId, foundJid)
					logger.info(`✅ تم العثور على مجموعة "${TARGET_GROUP_NAME}" بالمعرف: ${foundJid} للحساب [${sessionId}].`)
				} else {
					logger.warn(`⚠️ لم يتم العثور على مجموعة باسم "${TARGET_GROUP_NAME}" في الحساب [${sessionId}].`)
					logger.warn(`يرجى التأكد من إضافة هذا الحساب إلى مجموعة بهذا الاسم الدقيق.`)
				}
			} catch (err) {
				logger.error(`فشل جلب المجموعات للحساب [${sessionId}]: ${err}`)
			}
		}
	})

	// مراقبة الرسائل الواردة
	sock.ev.on('messages.upsert', async (upsert) => {
		if (upsert.type !== 'notify') return

		let targetGroupJid = sessionGroupJids.get(sessionId)

		for (const msg of upsert.messages) {
			// تجاهل الرسائل المرسلة من البوت نفسه لتجنب الحلقات اللانهائية
			if (msg.key.fromMe) continue

			// تجاهل رسائل النشرات (Newsletters)
			if (msg.key.remoteJid && isJidNewsletter(msg.key.remoteJid)) continue

			// تشغيل نظام معالجة وتوجيه طلبات مساعدة الطلاب (ملف مستقل)
			handleStudentLeads(msg, sock, sessionId).catch(err => {
				logger.error(`❌ خطأ أثناء معالجة طلبات الطلاب للحساب [${sessionId}]: ${err}`)
			})

			// تجاهل الرسائل القادمة من مجموعة التوجيه نفسها لتجنب التكرار
			if (targetGroupJid && msg.key.remoteJid === targetGroupJid) continue

			// استخراج نص الرسالة (من المحادثة النصية، أو الرسالة المقتبسة، أو الشرح على الميديا)
			const text = msg.message?.conversation || 
						 msg.message?.extendedTextMessage?.text || 
						 msg.message?.imageMessage?.caption || 
						 msg.message?.videoMessage?.caption || 
						 ''

			if (!text) continue

			// استخراج كافة روابط المجموعات ورموز الدعوة من النص باستخدام localRegex
			const matchedLinksWithCodes: { link: string; code: string }[] = []
			const localRegex = /https:\/\/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9]+)/gi
			let match;
			while ((match = localRegex.exec(text)) !== null) {
				matchedLinksWithCodes.push({ link: match[0], code: match[1] })
			}

			if (matchedLinksWithCodes.length > 0) {
				logger.info(`🔗 تم لقط ${matchedLinksWithCodes.length} روابط مجموعات في الحساب [${sessionId}] من المرسل [${msg.pushName || msg.key.remoteJid}]`)

				// إذا لم نكن قد جلبنا معرف المجموعة بعد، نقوم بجلبه الآن ديناميكياً
				if (!targetGroupJid) {
					try {
						logger.info(`🔍 جاري البحث عن مجموعة "${TARGET_GROUP_NAME}" ديناميكياً...`)
						const groups = await sock.groupFetchAllParticipating()
						const targetNormalized = normalizeArabic(TARGET_GROUP_NAME)
						for (const jid in groups) {
							const subject = groups[jid].subject
							const subjectNormalized = normalizeArabic(subject)
							if (subject === TARGET_GROUP_NAME || subjectNormalized === targetNormalized || subjectNormalized.includes('العمل')) {
								targetGroupJid = jid
								sessionGroupJids.set(sessionId, jid)
								logger.info(`✅ تم العثور على مجموعة "${TARGET_GROUP_NAME}" ديناميكياً بالمعرف: ${targetGroupJid}`)
								break
							}
						}
					} catch (err) {
						logger.error(`❌ فشل جلب المجموعات ديناميكياً للحساب [${sessionId}]: ${err}`)
					}
				}

				if (targetGroupJid) {
					// إضافة العملية إلى طابور الإرسال لتصفيتها وإرسالها بأمان
					queue.add(async () => {
						const cleanLinks: string[] = []

						for (const item of matchedLinksWithCodes) {
							// 1. فحص سريع لنص الرسالة نفسها للتأكد من عدم احتوائها على كلمات محظورة
							if (isSpam(text)) {
								logger.info(`🚫 [${sessionId}] تم حظر الرابط (${item.link}) لأن نص الرسالة يحتوي على كلمات سبام محظورة.`)
								continue
							}

							// 2. التحقق من اسم ووصف المجموعة من خلال رمز الدعوة دون الانضمام إليها
							try {
								logger.info(`🔍 [${sessionId}] جاري فحص معلومات الرابط (${item.code}) لمعرفة اسم المجموعة...`)
								const info = await sock.groupGetInviteInfo(item.code)
								if (info && (isSpam(info.subject) || (info.desc && isSpam(info.desc)))) {
									logger.info(`🚫 [${sessionId}] تم حظر الرابط لتبعيته لمجموعة إعلانية/سبام: "${info.subject}"`)
									continue
								}
							} catch (err) {
								logger.warn(`⚠️ [${sessionId}] تعذر فحص تفاصيل الرابط (${item.code}) عبر السيرفر: ${err}. سيتم اعتباره رابطاً عادياً.`)
							}

							cleanLinks.push(item.link)
						}

						// إذا كانت هناك روابط نظيفة بعد التصفية، نقوم بإرسالها مدمجة
						if (cleanLinks.length > 0) {
							const combinedLinks = cleanLinks.join('\n')

							// تأخير عشوائي بين 4 إلى 8 ثوانٍ لمحاكاة السلوك البشري وتجنب الحظر وفصل الاتصال
							const sleepTime = Math.floor(Math.random() * 4000) + 4000
							logger.info(`⏳ [${sessionId}] طابور الإرسال: الانتظار لمدة ${sleepTime / 1000} ثانية قبل توجيه الروابط النظيفة...`)
							await new Promise(resolve => setTimeout(resolve, sleepTime))

							try {
								await sock.sendMessage(targetGroupJid!, { text: combinedLinks })
								logger.info(`✅ [${sessionId}] تم توجيه الروابط النظيفة بنجاح:\n${combinedLinks}`)
							} catch (err) {
								logger.error(`❌ [${sessionId}] فشل توجيه الروابط: ${err}`)
							}
						} else {
							logger.info(`🚫 [${sessionId}] تم تصفية وحظر كافة الروابط الملقوطة من الرسالة لأنها سبام/إعلانية.`)
						}
					})
				} else {
					logger.warn(`⚠️ تم العثور على روابط مجموعات ولكن مجموعة "${TARGET_GROUP_NAME}" غير متصلة بعد لهذا الحساب ولم يتم العثور عليها ديناميكياً.`)
				}
			}
		}
	})
}

// دالة البدء الرئيسية لتشغيل كافة الحسابات
async function main() {
	// إنشاء مجلد جلسات العمل إذا لم يكن موجوداً
	if (!fs.existsSync('sessions')) {
		fs.mkdirSync('sessions')
	}

	// تشغيل خادم ويب HTTP بسيط (مهم جداً لمنصة Render لتجنب فشل التشغيل ولدعم إبقاء البوت مستيقظاً عبر البينج)
	const PORT = process.env.PORT || 3000
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
		res.end('WhatsApp Link Forwarder Bot is Active! 🚀')
	})
	server.listen(PORT, () => {
		logger.info(`🌐 خادم ويب بسيط يعمل على المنفذ: ${PORT}`)
	})

	for (const session of SESSIONS) {
		await startSession(session)
	}
}

main().catch(err => {
	logger.fatal(`فشل بدء نظام البوت الموجه: ${err}`)
})
