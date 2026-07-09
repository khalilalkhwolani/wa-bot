import { config } from '../config'

export interface AIAnalysisResult {
	classification: 'HELP_REQUEST' | 'SERVICE_AD' | 'DISCUSSION' | 'OTHER'
	confidence: number
	subject: string
	category: string
	urgency: 'High' | 'Medium' | 'Low'
	leadScore: number
	reason: string
}

/**
 * خدمة الاتصال بـ Gemini API لتصنيف الرسائل مع دعم سياق الردود المقتبسة
 */
export async function analyzeMessageWithAI(text: string, quotedContext?: string): Promise<AIAnalysisResult> {
	const apiKey = config.GEMINI_API_KEY
	if (!apiKey) {
		console.warn('⚠️ لم يتم العثور على متغير البيئة GEMINI_API_KEY. سيتم استخدام التصنيف المحلي الافتراضي.')
		return {
			classification: 'HELP_REQUEST',
			confidence: 0.50,
			subject: 'غير محدد',
			category: 'غير محدد',
			urgency: 'Medium',
			leadScore: 50,
			reason: 'تم التمرير كاحتياط لعدم توفر مفتاح الذكاء الاصطناعي (API Key)'
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
		console.error(`❌ خطأ أثناء الاتصال بـ Gemini API:`, err)
		return {
			classification: 'HELP_REQUEST',
			confidence: 0.50,
			subject: 'خطأ اتصال',
			category: 'غير محدد',
			urgency: 'Medium',
			leadScore: 50,
			reason: 'حدث خطأ اتصال بالذكاء الاصطناعي، تم التوجيه كاحتياط'
		}
	}
}
