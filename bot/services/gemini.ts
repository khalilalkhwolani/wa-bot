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

const GROQ_TIMEOUT_MS = 20_000
const VALID_CLASSIFICATIONS = new Set(['HELP_REQUEST', 'SERVICE_AD', 'DISCUSSION', 'OTHER'])
const VALID_URGENCIES = new Set(['High', 'Medium', 'Low'])

function parseAndValidateAIResult(raw: unknown): AIAnalysisResult {
	if (!raw || typeof raw !== 'object') {
		throw new Error('AI response is not a JSON object')
	}
	const data = raw as Record<string, unknown>
	const classification = String(data.classification || '')
	if (!VALID_CLASSIFICATIONS.has(classification)) {
		throw new Error(`Invalid AI classification: ${classification}`)
	}
	const confidence = Number(data.confidence)
	if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
		throw new Error(`Invalid AI confidence: ${data.confidence}`)
	}
	const urgency = String(data.urgency || 'Medium')
	if (!VALID_URGENCIES.has(urgency)) {
		throw new Error(`Invalid AI urgency: ${data.urgency}`)
	}
	const leadScore = Number(data.leadScore ?? 0)
	if (!Number.isFinite(leadScore)) {
		throw new Error(`Invalid AI leadScore: ${data.leadScore}`)
	}
	return {
		classification: classification as AIAnalysisResult['classification'],
		confidence,
		subject: String(data.subject || 'غير محدد').slice(0, 200),
		category: String(data.category || 'غير محدد').slice(0, 200),
		urgency: urgency as AIAnalysisResult['urgency'],
		leadScore: Math.max(0, Math.min(100, Math.round(leadScore))),
		reason: String(data.reason || '').slice(0, 500),
	}
}

async function tryGroq(prompt: string): Promise<AIAnalysisResult> {
	const apiKey = config.GROQ_API_KEY
	if (!apiKey) {
		throw new Error('Groq API Key is not configured')
	}

	const model = config.GROQ_MODEL || 'qwen/qwen3.8-27b'
	const url = 'https://api.groq.com/openai/v1/chat/completions'
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`
		},
		body: JSON.stringify({
			model,
			messages: [{ role: 'user', content: prompt }],
			response_format: { type: 'json_object' },
			temperature: 0.1,
			max_tokens: 400,
		}),
		signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
	})

	if (!response.ok) {
		const errText = await response.text().catch(() => '')
		throw new Error(`Groq API returned status ${response.status}: ${errText.slice(0, 300)}`)
	}

	const data: any = await response.json()
	let jsonText = data.choices?.[0]?.message?.content
	if (!jsonText) throw new Error('Empty response from Groq')

	// بعض نماذج Qwen تُرجع وسوم تفكير قبل JSON
	if (jsonText.includes('</think>')) {
		jsonText = jsonText.split('</think>').pop() || ''
	}
	const fenced = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
	if (fenced?.[1]) {
		jsonText = fenced[1]
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(jsonText.trim())
	} catch {
		throw new Error('Groq returned invalid JSON')
	}
	return parseAndValidateAIResult(parsed)
}

/**
 * مصنف الحالات الرمادية عبر Groq فقط.
 * عند الفشل يُرمى الخطأ إلى SLIE ليحفظ الحالة للمراجعة دون إرسال تلقائي.
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
- "احد يساعدني بحل الواجب" ← HELP_REQUEST (طلب مساعدة أكاديمية صريحة)

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

	console.log(`⚡ [AI] جاري فحص الرسالة عبر Groq (${config.GROQ_MODEL || 'qwen/qwen3.8-27b'})...`)
	try {
		return await tryGroq(prompt)
	} catch (groqErr: any) {
		console.error(`❌ [AI] فشل Groq: ${groqErr.message || groqErr}`)
		// فشل الذكاء الاصطناعي لا يجوز أن يتحول إلى قبول تلقائي.
		throw new Error('مصنف Groq غير متاح')
	}
}
