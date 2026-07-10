import { normalizeArabicText } from './normalizer';
import { IntentType, DynamicRule } from './types';

// القاموس الأكاديمي الافتراضي للمصطلحات الدراسية
export const DEFAULT_STUDY_NOUNS = [
	'واجب', 'واجبات', 'اختبار', 'اختبارات', 'امتحان', 'امتحانات', 'كويز', 'كويزات',
	'اسايمنت', 'اسايمنتات', 'بروجكت', 'بروجكتات', 'مشروع', 'مشاريع', 'تقرير', 'تقارير',
	'بحث', 'بحوث', 'تفريغ', 'ملخص', 'ملخصات', 'سلايدات', 'شابتر', 'شباتر', 'سؤال', 'سؤالين',
	'مسأله', 'مسائل', 'كود', 'أكواد', 'برمجه', 'فيزياء', 'كيمياء', 'رياضيات', 'احصاء',
	'محاسبه', 'قواعد بيانات', 'شبكات', 'انجليزي', 'تعبير', 'ميد', 'فاينل'
].map(normalizeArabicText);

// أفعال المساعدة الافتراضية
export const DEFAULT_HELP_VERBS = [
	'يساعدني', 'تساعدني', 'يساعد', 'تساعد', 'يحل', 'تحل', 'يسوي', 'تسوي', 'يفهم', 'تفهم',
	'يشرح', 'تشرح', 'يمسك', 'تمسك', 'يضبط', 'تضبط', 'يسعف', 'ينقذ', 'يعرف', 'تعرف',
	'يقدر', 'تقدر', 'يفزع', 'تفزع', 'يدرس', 'تدرس'
].map(normalizeArabicText);

// تعبيرات الفزعة والطلب الافتراضية
export const DEFAULT_HELP_EXPRESSIONS = [
	'فزعه', 'فزعتكم', 'تكفون', 'تكفى', 'افزعوا', 'ساعدوني', 'تساعدني', 'مساعده', 'مساعده',
	'ابي', 'ابغا', 'ابغى', 'أشتي', 'اشتي', 'يشتي', 'محتاج', 'محتاجه', 'مبتلش', 'متوهق',
	'ضايع', 'مش فاهم', 'مو فاهم', 'ما عرفت', 'ما فهمت', 'صعب علي', 'مين يعرف', 'أحد يعرف', 'احد يعرف',
	'مين يقدر', 'أحد يقدر', 'احد يقدر', 'مين يحل', 'أحد يحل', 'احد يحل', 'مين يمسك', 'أحد يمسك', 'احد يمسك',
	'من يحل', 'من يمسك', 'من يساعد', 'من يفهم', 'من يشرح', 'من يسوي', 'من يعرف', 'كيف احل', 'طريقة حل', 
	'شرح طريقة', 'ابغا فزعه', 'ابي فزعه', 'شلو واجب', 'امسكوا واجب', 'يسعفني'
].map(normalizeArabicText);

// العبارات الإعلانية الترويجية المحظورة افتراضياً
export const DEFAULT_AD_KEYWORDS = [
	'خدمات طلابيه', 'خدمات اكاديميه', 'نوفر لكم', 'نقدم لكم', 'مستعدون', 
	'اسعار مناسبه', 'حلول مضمونه', 'شعارنا الامانه', 'مكتبه', 'أعذار طبيه', 
	'اعذار طبيه', 'كادر', 'للتواصل عبر', 'للتواصل واتساب', 'للتواصل خاص',
	'بحوث علميه', 'عروض بوربوينت', 'سكليف', 'تنويم', 'تقرير طبي', 'تقارير طبيه',
	'كشف طبي', 'سيره ذاتيه', 'بحوثات', 'مشاريع تخرج', 'برزنتيشن', 'تلخيص كتب'
].map(normalizeArabicText);

/**
 * محرك النيات المحلي (Engine 3: Intent Engine)
 */
export function classifyIntentLocally(
	normalizedText: string, 
	dynamicRules: DynamicRule[] = []
): {
	intent: IntentType;
	localScore: number;
} {
	// دمج القواعد الافتراضية مع الديناميكية المستخلصة من قاعدة البيانات
	const studyNouns = [...DEFAULT_STUDY_NOUNS, ...dynamicRules.filter(r => r.category === 'STUDY_NOUN').map(r => r.key)];
	const helpVerbs = [...DEFAULT_HELP_VERBS, ...dynamicRules.filter(r => r.category === 'HELP_VERB').map(r => r.key)];
	const helpExpressions = [...DEFAULT_HELP_EXPRESSIONS, ...dynamicRules.filter(r => r.category === 'AD_KEYWORD' && r.weight > 0).map(r => r.key)];
	const adKeywords = [...DEFAULT_AD_KEYWORDS, ...dynamicRules.filter(r => r.category === 'AD_KEYWORD' && r.weight < 0).map(r => r.key)];

	let score = 0;

	// 1. التحقق من التعبيرات الإيجابية
	const matchedExpressions = helpExpressions.filter(word => normalizedText.includes(word));
	score += matchedExpressions.length * 30;

	const matchedNouns = studyNouns.filter(word => normalizedText.includes(word));
	const matchedVerbs = helpVerbs.filter(word => normalizedText.includes(word));

	if (matchedNouns.length > 0 && matchedVerbs.length > 0) {
		score += 25; // نقاط إضافية عند ترابط اسم دراسي مع فعل طلب مساعدة
	}

	// 2. خصم النقاط للتعبيرات السلبية (الإعلانية)
	const matchedAds = adKeywords.filter(word => normalizedText.includes(word));
	score -= matchedAds.length * 40;

	// التحقق من تعبيرات التواصل التجاري
	if (normalizedText.includes('للتواصل خاص') || normalizedText.includes('تواصل خاص')) {
		score -= 35;
	}

	// 3. تصنيف النية بناءً على النتيجة النهائية للنقاط
	let intent: IntentType = 'UNKNOWN';
	if (score >= 25) {
		intent = 'ASK_HELP';
	} else if (score < 0) {
		intent = 'SELL_SERVICE';
	} else if (matchedNouns.length > 0) {
		intent = 'DISCUSSION';
	} else if (normalizedText.includes('شكرا') || normalizedText.includes('تسلم') || normalizedText.includes('يعطيك')) {
		intent = 'THANKS';
	}

	return { intent, localScore: score };
}
