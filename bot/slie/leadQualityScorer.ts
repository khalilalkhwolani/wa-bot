import { normalizeArabicText } from './normalizer';

/**
 * محرك تقييم جودة الـ Lead الأكاديمي (Engine 9: Lead Quality Scorer)
 */

const PAYMENT_KEYWORDS = [
	'بفلوس', 'مقابل', 'حقك', 'فلوس', 'حساب', 'أتعاب', 'اتعاب', 'سعرك', 'كم تبي', 'بندفع', 'ندفع'
].map(normalizeArabicText);

const URGENT_KEYWORDS = [
	'اليوم', 'الليله', 'بكره', 'عاجل', 'الان', 'سريع', 'بليز', 'تكفون', 'اسعفوني', 'الحين'
].map(normalizeArabicText);

/**
 * حساب نقاط الجودة (Lead Quality Score) من 0 إلى 100
 */
export function calculateLeadQualityScore(text: string, subject: string): number {
	const normalizedText = normalizeArabicText(text);
	let score = 30; // النتيجة الأساسية للفرصة المقبولة

	// 1. فحص مؤشرات الرغبة في الدفع ومقابل الأتعاب (+40 نقطة)
	const hasPaymentIntent = PAYMENT_KEYWORDS.some(word => normalizedText.includes(word));
	if (hasPaymentIntent) {
		score += 40;
	}

	// 2. فحص مؤشرات الاستعجال (+20 نقطة)
	const hasUrgency = URGENT_KEYWORDS.some(word => normalizedText.includes(word));
	if (hasUrgency) {
		score += 20;
	}

	// 3. تحديد المادة الدراسية بوضوح (+10 نقاط)
	if (subject && subject !== 'غير محدد' && subject !== 'خطأ اتصال') {
		score += 10;
	}

	return Math.min(100, score);
}
