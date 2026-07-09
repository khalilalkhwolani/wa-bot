import makeWASocket, { isJidNewsletter } from '../src'
import P from 'pino'
import PQueue from 'p-queue'

// إعداد السجل (Pino Logger) بنفس تهيئة الملف الرئيسي
const logger = P({
	level: 'info',
	transport: {
		target: 'pino-pretty',
		options: { colorize: true }
	}
})

// اسم المجموعة المستهدفة لتوجيه طلبات الطلاب إليها
const TARGET_LEADS_GROUP_NAME = 'طلبات الطلاب'

// خريطة لتخزين معرفات مجموعات الطلاب لكل حساب (Session ID -> Group JID)
const sessionLeadsGroupJids = new Map<string, string>()

// خريطة لتخزين طوابير إرسال الطلاب لكل حساب لمنع التداخل والـ Rate Limits لـ AI (Session ID -> PQueue)
const sessionLeadsQueues = new Map<string, PQueue>()

// الكلمات المفتاحية الأكاديمية الأولية للفحص السريع (Rule Engine)
const STUDY_KEYWORDS = [
	'واجب', 'حل', 'اختبار', 'امتحان', 'كويز', 'اسايمنت', 'مشروع', 'بروجكت', 
	'شرح', 'مساعده', 'يحل', 'يفهم', 'سؤال', 'سؤالين', 'مسأله', 'مسائل', 
	'دكتور', 'مبتلش', 'فزعتكم', 'تكفون', 'أبي', 'أبغا', 'أشتي', 'يشتي', 
	'ساعدوني', 'تساعدني', 'يساعدني', 'طريقه', 'مين يعرف', 'أحد يعرف', 'فزعه'
].map(normalizeArabicSearch)

// دالة تطبيع النصوص العربية للمطابقة الدقيقة
function normalizeArabic(text: string): string {
	if (!text) return ''
	return text
		.replace(/ة/g, 'ه')
		.replace(/\s+/g, '')
		.trim()
}

function normalizeArabicSearch(text: string): string {
	if (!text) return ''
	return text
		.toLowerCase()
		.replace(/[أإآ]/g, 'ا')
		.replace(/ة/g, 'ه')
		.replace(/ى/g, 'ي')
		.trim()
}

/**
 * فلتر محلي سريع (Rule Engine) لتصفية الرسائل غير المهمة قبل إرسالها للذكاء الاصطناعي
 */
function shouldAnalyze(text: string): boolean {
	if (!text || text.length < 15) return false

	// تجنب الرسائل التي تحتوي على إيموجيات فقط
	const emojiRegex = /^[\s\p{Emoji}\p{Extended_Pictographic}]+$/u
	if (emojiRegex.test(text)) return false

	// تجنب الرسائل التي تحتوي على روابط فقط (الروابط تعالج في الملف الآخر)
	if (text.trim().startsWith('http://') || text.trim().startsWith('https://')) return false

	const normalizedText = normalizeArabicSearch(text)

	// التحقق من وجود كلمة مفتاحية أكاديمية واحدة على الأقل
	return STUDY_KEYWORDS.some(keyword => normalizedText.includes(keyword))
}

/**
 * دالة الاتصال بـ Gemini API لتصنيف الرسالة بدقة واستخراج البيانات
 */
async function analyzeWithAI(text: string, quotedContext?: string): Promise<{
	classification: 'HELP_REQUEST' | 'SERVICE_AD' | 'DISCUSSION' | 'OTHER'
	confidence: number
	subject: string
	category: string
	urgency: 'High' | 'Medium' | 'Low'
	leadScore: number
	reason: string
}> {
	const apiKey = process.env.GEMINI_API_KEY
	if (!apiKey) {
		logger.warn('⚠️ لم يتم العثور على متغير البيئة GEMINI_API_KEY. سيتم استخدام الفحص المحلي البسيط.')
		// تراجع تلقائي محلي إذا لم يتوفر المفتاح
		return {
			classification: 'HELP_REQUEST',
			confidence: 0.50,
			subject: 'غير محدد',
			category: 'غير محدد',
			urgency: 'Medium',
			leadScore: 60,
			reason: 'تم الالتقاط تلقائياً عبر الفحص المحلي (بدون AI)'
		}
	}

	const prompt = `
أنت محلل محادثات أكاديمي وخبير في تصفية وتصنيف رسائل الطلاب واستخراج الفرص (Leads).
مهمتك هي قراءة الرسالة الواردة (وقراءة سياق الرسالة المقتبسة إن وجد) وتصنيفها بدقة تامة.

سياق الرسالة المقتبسة (Quoted Message Context):
"${quotedContext || 'لا يوجد'}"

الرسالة الواردة للتحليل (Incoming Message):
"${text}"

تعليمات التصنيف الصارمة:
1. تصنيف HELP_REQUEST: إذا كان مرسل الرسالة هو طالب يطلب مساعدة لنفسه في واجب، اختبار، شرح، أو مشروع تخرج (سواء بلهجة سعودية أو يمنية أو عامية).
2. تصنيف SERVICE_AD: إذا كان مرسل الرسالة هو معلن يعلن عن تقديم خدمات، أو يعيد توجيه الطلاب لأرقام أو مجموعات أخرى، أو يوصي برقم آخر (حتى لو كتب بلهجة طالب).
3. تصنيف DISCUSSION: نقاش أو دردشة عادية بين الطلاب دون طلب مساعدة حقيقية.
4. تصنيف OTHER: أي رسائل سلام، ترحيب، أو خارج السياق الدراسي.

اللهجات المساعدة:
- اللهجة السعودية والخليجية: (أبي/أبغا أحد يحل لي، مبتلش في واجب، فزعتكم يا رجال، تكفون، منهو يعرف).
- اللهجة اليمنية: (أشتي/يشتي حل، من يمسك واجب، ما سبرش معي الكود).

يجب أن تعيد النتيجة بصيغة JSON فقط ككائن يحتوي على الحقول التالية وبدون أي تعليقات أو نصوص إضافية:
{
  "classification": "HELP_REQUEST" | "SERVICE_AD" | "DISCUSSION" | "OTHER",
  "confidence": number (من 0.0 إلى 1.0),
  "subject": string (اسم المادة الدراسية، مثلاً: "جافا", "رياضيات", "فيزياء" أو "غير محدد"),
  "category": string (نوع الطلب، مثلاً: "واجب", "اختبار", "مشروع تخرج", "شرح" أو "غير محدد"),
  "urgency": "High" | "Medium" | "Low",
  "leadScore": number (درجة جودة الفرصة من 0 إلى 100 بناءً على رغبة الطالب في الدفع أو عجلة الطلب),
  "reason": string (شرح بسيط ومختصر باللغة العربية لسبب هذا التصنيف)
}
`

	try {
		const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				contents: [{ parts: [{ text: prompt }] }],
				generationConfig: {
					responseMimeType: 'application/json'
				}
			})
		})

		if (!response.ok) {
			throw new Error(`Gemini API returned status ${response.status}`)
		}

		const data: any = await response.json()
		const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text
		if (!jsonText) throw new Error('Empty response from Gemini')

		return JSON.parse(jsonText.trim())
	} catch (err) {
		logger.error(`❌ خطأ أثناء الاتصال بـ Gemini API: ${err}`)
		// تراجع آمن في حال حدوث خطأ اتصال
		return {
			classification: 'HELP_REQUEST',
			confidence: 0.50,
			subject: 'خطأ اتصال',
			category: 'غير محدد',
			urgency: 'Medium',
			leadScore: 50,
			reason: 'حدث خطأ أثناء الاتصال بالذكاء الاصطناعي، تم التوجيه كاحتياط'
		}
	}
}

/**
 * الدالة الأساسية المستدعاة من الملف الرئيسي لمعالجة وتوجيه طلبات مساعدة الطلاب
 */
export async function handleStudentLeads(msg: any, sock: any, sessionId: string) {
	// تجاهل الرسائل المرسلة من البوت نفسه
	if (msg.key.fromMe) return

	// تجاهل رسائل القنوات والنشرات
	if (msg.key.remoteJid && isJidNewsletter(msg.key.remoteJid)) return

	// جلب طابور الإرسال الخاص بالجلسة أو إنشائه
	let queue = sessionLeadsQueues.get(sessionId)
	if (!queue) {
		queue = new PQueue({ concurrency: 1 })
		sessionLeadsQueues.set(sessionId, queue)
	}

	// استخراج نص الرسالة
	const text = msg.message?.conversation || 
				 msg.message?.extendedTextMessage?.text || 
				 msg.message?.imageMessage?.caption || 
				 msg.message?.videoMessage?.caption || 
				 ''

	if (!text) return

	// استخراج الرسالة المقتبسة وسياق الرد (Quoted message)
	const quotedMsgObj = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
	let quotedText = ''
	if (quotedMsgObj) {
		quotedText = quotedMsgObj.conversation || 
					 quotedMsgObj.extendedTextMessage?.text || 
					 quotedMsgObj.imageMessage?.caption || 
					 quotedMsgObj.videoMessage?.caption || 
					 ''
	}

	// 1. تشغيل الفلتر السريع (Rule Engine)
	if (!shouldAnalyze(text) && (!quotedText || !shouldAnalyze(quotedText))) {
		return
	}

	// جلب معرف مجموعة الطلاب المستهدفة
	let targetLeadsJid = sessionLeadsGroupJids.get(sessionId)

	// إضافة العملية إلى طابور المعالجة
	queue.add(async () => {
		// 2. تحليل الرسالة بالذكاء الاصطناعي (Gemini)
		logger.info(`🤖 [${sessionId}] جاري فحص الرسالة عبر الذكاء الاصطناعي...`)
		const analysis = await analyzeWithAI(text, quotedText)

		// التحقق من التصنيف وجودة الفرصة
		if (analysis.classification !== 'HELP_REQUEST' || analysis.leadScore < 45) {
			logger.info(`🚫 [${sessionId}] تم تجاهل الرسالة لأنها تصنيف: ${analysis.classification} (التقييم: ${analysis.leadScore})`)
			return
		}

		// إذا لم نكن قد جلبنا معرف المجموعة المستهدفة بعد، نقوم بجلبه ديناميكياً
		if (!targetLeadsJid) {
			try {
				logger.info(`🔍 [${sessionId}] جاري البحث عن مجموعة "${TARGET_LEADS_GROUP_NAME}"...`)
				const groups = await sock.groupFetchAllParticipating()
				const targetNormalized = normalizeArabic(TARGET_LEADS_GROUP_NAME)
				
				for (const jid in groups) {
					const subject = groups[jid].subject
					const subjectNormalized = normalizeArabic(subject)
					if (subject === TARGET_LEADS_GROUP_NAME || subjectNormalized === targetNormalized || subjectNormalized.includes('طلاب') || subjectNormalized.includes('طلب')) {
						targetLeadsJid = jid
						sessionLeadsGroupJids.set(sessionId, jid)
						logger.info(`✅ [${sessionId}] تم العثور على مجموعة "${TARGET_LEADS_GROUP_NAME}" بالمعرف: ${targetLeadsJid}`)
						break
					}
				}
			} catch (err) {
				logger.error(`❌ [${sessionId}] فشل جلب مجموعة الطلاب ديناميكياً: ${err}`)
			}
		}

		if (targetLeadsJid) {
			// استخراج رقم هاتف الطالب وصياغة رابط التواصل
			const participantJid = msg.key.participant || msg.key.remoteJid || ''
			const phone = participantJid.split('@')[0]
			const chatLink = `https://wa.me/${phone}`

			// جلب اسم المجموعة الأصلية التي أرسل فيها الطالب
			let originalGroupSubject = 'غير معروف'
			if (msg.key.remoteJid && msg.key.remoteJid.endsWith('@g.us')) {
				try {
					const metadata = await sock.groupMetadata(msg.key.remoteJid)
					originalGroupSubject = metadata.subject || 'غير معروف'
				} catch (err) {
					// تراجع آمن في حال عدم القدرة على جلب بيانات المجموعة لتفادي الحظر
					originalGroupSubject = 'مجموعة عامة'
				}
			}

			// صياغة التنبيه المنسق والاحترافي
			const alertMessage = `🚨 *طلب مساعدة من طالب (Lead)*

👤 *الطالب:* ${msg.pushName || 'غير مسجل'} (@${phone})
👥 *المجموعة المصدر:* ${originalGroupSubject}
📚 *المادة:* ${analysis.subject || 'غير محدد'}
🗂️ *التصنيف:* ${analysis.category || 'غير محدد'}
🔥 *الأهمية:* ${analysis.urgency === 'High' ? '🔴 عالية جداً' : analysis.urgency === 'Medium' ? '🟡 متوسطة' : '⚪ منخفضة'}
💡 *التحليل:* ${analysis.reason}

💬 *الرسالة الأصلية:*
"${text}"
${quotedText ? `\n💬 *رد على رسالة:* "${quotedText}"` : ''}

🔗 *رابط التواصل المباشر مع الطالب:*
${chatLink}`

			// تأخير عشوائي بسيط لتجنب التزامن والحظر
			const sleepTime = Math.floor(Math.random() * 3000) + 2000
			await new Promise(resolve => setTimeout(resolve, sleepTime))

			try {
				await sock.sendMessage(targetLeadsJid, { text: alertMessage })
				logger.info(`✅ [${sessionId}] تم توجيه طلب الطالب بنجاح لمجموعة "${TARGET_LEADS_GROUP_NAME}"`)
			} catch (err) {
				logger.error(`❌ [${sessionId}] فشل إرسال تنبيه الطالب: ${err}`)
			}
		} else {
			logger.warn(`⚠️ تم العثور على طلب طالب ولكن مجموعة "${TARGET_LEADS_GROUP_NAME}" غير متصلة بعد لهذا الحساب.`)
		}
	})
}
