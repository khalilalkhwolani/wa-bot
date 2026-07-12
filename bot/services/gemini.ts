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

async function tryMiniMax(prompt: string): Promise<AIAnalysisResult> {
	const apiKey = config.MINIMAX_API_KEY
	if (!apiKey) {
		throw new Error('MiniMax API Key is not configured')
	}

	const url = 'https://api.minimax.io/v1/chat/completions'
	const response = await fetch(url, {
		method: 'POST',
		headers: { 
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`
		},
		body: JSON.stringify({
			model: 'MiniMax-M3',
			messages: [
				{ role: 'user', content: prompt }
			],
			response_format: { type: 'json_object' }
		})
	})

	if (!response.ok) {
		const errText = await response.text().catch(() => '')
		throw new Error(`MiniMax API returned status ${response.status}: ${errText}`)
	}

	const data: any = await response.json()
	const jsonText = data.choices?.[0]?.message?.content
	if (!jsonText) throw new Error('Empty response from MiniMax')

	return JSON.parse(jsonText.trim())
}

async function tryGroq(prompt: string): Promise<AIAnalysisResult> {
	const apiKey = config.GROQ_API_KEY
	if (!apiKey) {
		throw new Error('Groq API Key is not configured')
	}

	const url = 'https://api.groq.com/openai/v1/chat/completions'
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`
		},
		body: JSON.stringify({
			model: 'llama-3.3-70b-versatile',
			messages: [{ role: 'user', content: prompt }],
			response_format: { type: 'json_object' },
			temperature: 0.1
		})
	})

	if (!response.ok) {
		const errText = await response.text().catch(() => '')
		throw new Error(`Groq API returned status ${response.status}: ${errText}`)
	}

	const data: any = await response.json()
	const jsonText = data.choices?.[0]?.message?.content
	if (!jsonText) throw new Error('Empty response from Groq')

	return JSON.parse(jsonText.trim())
}

async function tryGemini(prompt: string): Promise<AIAnalysisResult> {
	const apiKey = config.GEMINI_API_KEY
	if (!apiKey) {
		throw new Error('Gemini API Key is not configured')
	}

	const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`
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
		const errText = await response.text().catch(() => '')
		throw new Error(`Gemini API returned status ${response.status}: ${errText}`)
	}

	const data: any = await response.json()
	const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text
	if (!jsonText) throw new Error('Empty response from Gemini')

	return JSON.parse(jsonText.trim())
}

/**
 * خدمة الاتصال بالذكاء الاصطناعي مع دعم سلاسل بديلة (MiniMax -> Gemini -> Fallback محلي)
 */
export async function analyzeMessageWithAI(text: string, quotedContext?: string): Promise<AIAnalysisResult> {
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

	// 1. محاولة الاتصال بـ Groq (الأسرع والأوفر)
	try {
		console.log('⚡ [AI] جاري فحص الرسالة عبر Groq (llama-3.3-70b)...')
		return await tryGroq(prompt)
	} catch (groqErr: any) {
		console.warn(`⚠️ [AI] فشل Groq: ${groqErr.message || groqErr}`)

		// 2. محاولة MiniMax في حال فشل Groq
		try {
			console.log('🔄 [AI] محاولة بديلة عبر MiniMax...')
			return await tryMiniMax(prompt)
		} catch (minimaxErr: any) {
			console.warn(`⚠️ [AI] فشل MiniMax: ${minimaxErr.message || minimaxErr}`)

			// 3. محاولة Gemini كآخر بديل
			try {
				console.log('🔄 [AI] محاولة أخيرة عبر Gemini...')
				return await tryGemini(prompt)
			} catch (geminiErr: any) {
				console.error(`❌ [AI] فشل كل الخدمات: ${geminiErr.message || geminiErr}`)

				// 4. الرجوع للتصفية المحلية الاحتياطية
				return {
					classification: 'HELP_REQUEST',
					confidence: 0.50,
					subject: 'خطأ اتصال بالذكاء الاصطناعي',
					category: 'غير محدد',
					urgency: 'Medium',
					leadScore: 50,
					reason: 'فشل الاتصال بكل خدمات الذكاء الاصطناعي، تم التمرير احتياطياً'
				}
			}
		}
	}
}
