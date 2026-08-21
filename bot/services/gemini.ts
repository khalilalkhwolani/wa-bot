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

	const url = 'https://inference.dahl.global/v1/chat/completions'
	const response = await fetch(url, {
		method: 'POST',
		headers: { 
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`
		},
		body: JSON.stringify({
			model: 'MiniMaxAI/MiniMax-M2.7',
			messages: [
				{ role: 'user', content: prompt }
			]
		})
	})

	if (!response.ok) {
		const errText = await response.text().catch(() => '')
		throw new Error(`MiniMax API returned status ${response.status}: ${errText}`)
	}

	const data: any = await response.json()
	let jsonText = data.choices?.[0]?.message?.content
	if (!jsonText) throw new Error('Empty response from MiniMax')

	// إزالة وسوم التفكير <think>...</think> التي قد يرجعها النموذج لتفادي فشل الـ JSON.parse
	if (jsonText.includes('</think>')) {
		jsonText = jsonText.split('</think>').pop() || ''
	}

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
	const prompt = `أنت مصنّف رسائل دقيق جداً. مهمتك الوحيدة: هل هذه الرسالة طلب خدمة أكاديمية حقيقي يمكن بيعه كخدمة (حل واجب، شرح مادة، حل اختبار، مشروع تخرج، كتابة بحث) أم لا؟

=== تعريف HELP_REQUEST الصارم ===
صنّف كـ HELP_REQUEST فقط وحصرياً إذا تحققت كل الشروط التالية معاً:
1. الطالب يطلب شيئاً أكاديمياً محدداً (واجب، اختبار، شرح مادة، مشروع، بحث، ملخص، كتاب، خطة دراسية)
2. الطلب يمكن أن يؤدى كخدمة مدفوعة من شخص آخر
3. الرسالة ليست مجرد دردشة أو سؤال عام في محادثة جارية

=== أمثلة على HELP_REQUEST الصحيحة ===
- "ابي احد يحل لي واجب جافا" ← HELP_REQUEST (طلب حل واجب محدد)
- "ابغى ملخص فيزياء الفاينل" ← HELP_REQUEST (طلب ملخص مادة)
- "من يمسك لي مشروع تخرج" ← HELP_REQUEST (طلب خدمة مشروع)
- "ابغى كتب المناقشة عبد ربه والتميمي" ← HELP_REQUEST (طلب مواد دراسية محددة)
- "ابغى خطة الطالبات حق تخصص علوم التغذية" ← HELP_REQUEST (طلب خطة دراسية)
- "تكفون احد يشرح لي قواعد بيانات" ← HELP_REQUEST (طلب شرح مادة)
- "محتاج حل اسايمنت احصاء ضروري" ← HELP_REQUEST (طلب حل واجب)

=== أمثلة على DISCUSSION (ليست طلبات مساعدة) - مهم جداً ===
- "ابي بريك بين كل تسميعه والثانيه" ← DISCUSSION (دردشة عن جدول شخصي)
- "الأبواب مقفلة كلها لو ابي اجلس فيها" ← DISCUSSION (سؤال عام عن مكان)
- "ابي الاكيد بالله" ← DISCUSSION (تأكيد في محادثة عادية)
- "انا عندي تدريب صيفي واي غياب يأثر" ← DISCUSSION (مشاركة موقف شخصي)
- "عادي بنفس محاضرتها اذا قلتي لها" ← DISCUSSION (نصيحة بين طالبات)
- "راسليه على المودل" ← DISCUSSION (توجيه عام)
- "متى الاختبار؟" ← DISCUSSION (سؤال عام وليس طلب خدمة)
- "وش رايكم في الدكتور فلان" ← DISCUSSION (رأي)
- "انا عنده" ← DISCUSSION (رد قصير في محادثة)

=== القاعدة الذهبية ===
كلمات مثل "ابي" و"ابغى" و"أشتي" لا تعني بالضرورة طلب مساعدة أكاديمية!
هذه كلمات يومية عادية تستخدم في كل المحادثات العربية.
يجب أن يكون هناك سياق أكاديمي واضح (اسم مادة، نوع مهمة) حتى تصنفها HELP_REQUEST.

=== تصنيفات أخرى ===
- SERVICE_AD: إعلان عن تقديم خدمات أكاديمية ("من يبي واجبات يراسلني"، "نقدم لكم خدمات")
- OTHER: سلام، شكر، رسائل خارج السياق

سياق الرسالة المقتبسة: "${quotedContext || 'لا يوجد'}"
الرسالة: "${text}"

أعد النتيجة كـ JSON فقط بدون أي نص إضافي:
{"classification":"HELP_REQUEST"|"SERVICE_AD"|"DISCUSSION"|"OTHER","confidence":number,"subject":string,"category":string,"urgency":"High"|"Medium"|"Low","leadScore":number,"reason":string}
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
					classification: 'DISCUSSION',
					confidence: 0.20,
					subject: 'خطأ اتصال بالذكاء الاصطناعي',
					category: 'غير محدد',
					urgency: 'Low',
					leadScore: 0,
					reason: 'فشل الاتصال بكل خدمات الذكاء الاصطناعي، تم الرفض احتياطياً'
				}
			}
		}
	}
}
