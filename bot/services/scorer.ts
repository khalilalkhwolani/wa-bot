import { AIAnalysisResult } from './gemini'

/**
 * خدمة تقييم جودة الـ Lead وتحديد ما إذا كان يستحق المتابعة والإرسال
 */
export function evaluateLead(analysis: AIAnalysisResult): {
	shouldNotify: boolean
	reason: string
} {
	// 1. التحقق من التصنيف الرئيسي
	if (analysis.classification !== 'HELP_REQUEST') {
		return {
			shouldNotify: false,
			reason: `تم استبعاد الرسالة لأنها تصنيف: ${analysis.classification}`
		}
	}

	// 2. التحقق من درجة الثقة (Confidence) للـ AI
	if (analysis.confidence < 0.55) {
		return {
			shouldNotify: false,
			reason: `ثقة تصنيف الذكاء الاصطناعي منخفضة جداً (${analysis.confidence})`
		}
	}

	// 3. التحقق من النقاط (Score Threshold)
	const MIN_SCORE = 30
	if (analysis.leadScore < MIN_SCORE) {
		return {
			shouldNotify: false,
			reason: `نقاط جودة الفرصة منخفضة (${analysis.leadScore}) عن الحد الأدنى (${MIN_SCORE})`
		}
	}

	return {
		shouldNotify: true,
		reason: `فرصة صالحة (التقييم: ${analysis.leadScore}، الثقة: ${analysis.confidence})`
	}
}
