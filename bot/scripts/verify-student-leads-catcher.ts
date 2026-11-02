/**
 * تحقق محلي سريع لمسار طلبات الطلاب فقط (بدون واتساب وبدون إرسال).
 * يشغّل: npx tsx bot/scripts/verify-student-leads-catcher.ts
 */
import { normalizeArabicText } from '../slie/normalizer'
import { classifyIntentLocally } from '../slie/intentEngine'
import { calculateLocalConfidence } from '../slie/confidenceEngine'
import { analyzeMessageWithAI } from '../services/gemini'
import { config } from '../config'

type ExpectRoute = 'PASS' | 'REJECT' | 'AI_GRAY'

interface Case {
	label: string
	text: string
	expect: ExpectRoute
}

const cases: Case[] = [
	{ label: 'طلب صريح مساعدة واجب', text: 'احد يساعدني بحل الواجب ؟', expect: 'PASS' },
	{ label: 'طلب صريح مع كلمات وسطية', text: 'اشتي شخص متخصص يشرح لي المشروع', expect: 'PASS' },
	{ label: 'محتاج احد يسوي المشروع', text: 'محتاج أحد يسوي المشروع', expect: 'PASS' },
	{ label: 'ابي احد يحل واجب', text: 'ابي احد يحل لي واجب جافا', expect: 'PASS' },
	{ label: 'موعد اختبار', text: 'متى موعد الاختبار؟', expect: 'REJECT' },
	{ label: 'دردشة عامة', text: 'ي شباب هذا التوصيل ينفع بين العمليات', expect: 'REJECT' },
	{ label: 'إعلان خدمات', text: 'نقدم لكم خدمات طلابيه اسعار مناسبه للتواصل خاص', expect: 'REJECT' },
	{ label: 'كلمة ابي وحدها', text: 'ابي', expect: 'REJECT' },
]

function routeOf(text: string): { intent: string; localScore: number; routingDecision: ExpectRoute } {
	const normalized = normalizeArabicText(text)
	const { intent, localScore } = classifyIntentLocally(normalized)
	const { routingDecision } = calculateLocalConfidence(localScore, 0, 0.5)
	return { intent, localScore, routingDecision }
}

async function main() {
	console.log('=== تحقق لاقط طلبات الطلاب (قواعد محلية) ===\n')
	let failed = 0
	for (const item of cases) {
		const result = routeOf(item.text)
		const ok = result.routingDecision === item.expect
		if (!ok) failed += 1
		console.log(
			`${ok ? 'OK' : 'FAIL'} | ${item.label} | expect=${item.expect} got=${result.routingDecision} ` +
			`score=${result.localScore} intent=${result.intent}`
		)
	}

	console.log('\n=== تحقق Groq (إن وُجد المفتاح) ===')
	if (!config.GROQ_API_KEY) {
		console.log('SKIP | GROQ_API_KEY غير مضبوط — الحالات الرمادية ستُحفظ للمراجعة دون إرسال')
	} else {
		try {
			const ai = await analyzeMessageWithAI('احد يساعدني بحل واجب الفيزياء')
			console.log(`OK | Groq classification=${ai.classification} confidence=${ai.confidence}`)
		} catch (err) {
			failed += 1
			console.log(`FAIL | Groq: ${err}`)
		}
	}

	console.log('\n=== وضع التشغيل الحالي ===')
	console.log(`ENABLE_STUDENT_LEADS=${config.ENABLE_STUDENT_LEADS}`)
	console.log(`STUDENT_LEADS_MODE=${config.STUDENT_LEADS_MODE}`)
	console.log(`STUDENT_LEADS_SEND_ENABLED=${config.STUDENT_LEADS_SEND_ENABLED}`)
	if (!config.ENABLE_STUDENT_LEADS || config.STUDENT_LEADS_MODE === 'disabled') {
		console.log('ملاحظة: فعّل dry-run عبر ENABLE_STUDENT_LEADS=true و STUDENT_LEADS_MODE=dry-run')
	} else if (config.STUDENT_LEADS_MODE === 'dry-run') {
		console.log('وضع dry-run نشط: التصنيف والحفظ بدون إرسال واتساب')
	} else if (config.STUDENT_LEADS_MODE === 'send' && config.STUDENT_LEADS_SEND_ENABLED) {
		console.log('وضع الإرسال نشط')
	}

	if (failed > 0) {
		console.error(`\nفشل ${failed} فحص/فحوصات`)
		process.exit(1)
	}
	console.log('\nكل فحوصات لاقط الطلبات نجحت')
}

main().catch(err => {
	console.error(err)
	process.exit(1)
})
