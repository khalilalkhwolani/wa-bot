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

// تعبيرات الطلب القوية: هذه تدل بوضوح على طلب مساعدة (تعطي نقاط مباشرة)
export const DEFAULT_STRONG_HELP_EXPRESSIONS = [
	'فزعه', 'فزعتكم', 'تكفون', 'تكفى', 'افزعوا', 'ساعدوني', 'تساعدني', 'مساعده',
	'محتاج', 'محتاجه', 'مبتلش', 'متوهق',
	'ضايع', 'مش فاهم', 'مو فاهم', 'ما عرفت', 'ما فهمت', 'صعب علي',
	'مين يحل', 'أحد يحل', 'احد يحل', 'مين يمسك', 'أحد يمسك', 'احد يمسك',
	'من يحل', 'من يمسك', 'من يساعد', 'من يشرح', 'من يسوي',
	'كيف احل', 'طريقة حل', 'شرح طريقة',
	'ابغا فزعه', 'ابي فزعه', 'شلو واجب', 'امسكوا واجب', 'يسعفني',
	'مين يعرف', 'أحد يعرف', 'احد يعرف', 'من يعرف',
	'مين يقدر', 'أحد يقدر', 'احد يقدر'
].map(normalizeArabicText);

// تعبيرات طلب ضعيفة: هذه كلمات يومية عادية (ابي، ابغى، أشتي) لا تعطي نقاط إلا مع سياق أكاديمي
export const DEFAULT_WEAK_DESIRE_WORDS = [
	'ابي', 'ابغا', 'ابغى', 'أشتي', 'اشتي', 'يشتي'
].map(normalizeArabicText);

// العبارات الإعلانية الترويجية المحظورة افتراضياً
export const DEFAULT_AD_KEYWORDS = [
	'خدمات طلابيه', 'خدمات اكاديميه', 'نوفر لكم', 'نقدم لكم', 'مستعدون', 
	'اسعار مناسبه', 'حلول مضمونه', 'شعارنا الامانه', 'مكتبه', 'أعذار طبيه', 
	'اعذار طبيه', 'كادر', 'للتواصل عبر', 'للتواصل واتساب', 'للتواصل خاص',
	'بحوث علميه', 'عروض بوربوينت', 'سكليف', 'تنويم', 'تقرير طبي', 'تقارير طبيه',
	'كشف طبي', 'سيره ذاتيه', 'بحوثات', 'مشاريع تخرج', 'برزنتيشن', 'تلخيص كتب',
	'الي يبي', 'الي يشتي', 'الي يحتاج', 'اللي يبي', 'اللي يحتاج', 'من يبي', 'من يشتي',
	'من يحتاج', 'يسوي واجبات', 'يسوي البحوث', 'يسوي مشاريع', 'يسوي الواجب', 'يسوي التكاليف',
	'يسوي بحوث', 'يسوي التكليف', 'يبشر', 'تبشر', 'يبشر بالخير', 'نوفر', 'نقدم', 'اسعار',
	'سعر', 'باقل الاسعار', 'باقل سعر', 'مضمون', 'ثقه', 'شخص ثقه', 'قروب حراج', 'للتواصل',
	'رقم المبرمج', 'رقم المحاسب', 'رقم المكتبه', 'خاص مفتوح', 'خاصك', 'مرسل خاص',
	'راسلني خاص', 'تعال خاص', 'تعالي خاص', 'تعالو خاص', 'اكتبوا لي خاص', 'كلمني خاص',
	'تواصل معي', 'واتساب'
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
	const strongHelpExpressions = [...DEFAULT_STRONG_HELP_EXPRESSIONS, ...dynamicRules.filter(r => r.category === 'AD_KEYWORD' && r.weight > 0).map(r => r.key)];
	const weakDesireWords = [...DEFAULT_WEAK_DESIRE_WORDS];
	const adKeywords = [...DEFAULT_AD_KEYWORDS, ...dynamicRules.filter(r => r.category === 'AD_KEYWORD' && r.weight < 0).map(r => r.key)];

	let score = 0;

	const matchedNouns = studyNouns.filter(word => normalizedText.includes(word));
	const matchedVerbs = helpVerbs.filter(word => normalizedText.includes(word));

	// 1. التحقق من التعبيرات القوية (فزعه، ساعدوني، محتاج...) → نقاط مباشرة
	const matchedStrongExpressions = strongHelpExpressions.filter(word => normalizedText.includes(word));
	score += Math.min(60, matchedStrongExpressions.length * 30);

	// 2. التحقق من الكلمات الضعيفة (ابي، ابغى، أشتي) → نقاط فقط إذا ترافقت مع سياق أكاديمي
	const matchedWeakDesire = weakDesireWords.filter(word => normalizedText.includes(word));
	if (matchedWeakDesire.length > 0 && (matchedNouns.length > 0 || matchedVerbs.length > 0)) {
		// "ابي + واجب" أو "ابغى + حل" = طلب مساعدة حقيقي
		score += 30;
	}
	// ملاحظة: "ابي" بدون سياق أكاديمي لا تعطي أي نقاط (دردشة عادية)

	if (matchedNouns.length > 0 && matchedVerbs.length > 0) {
		score += 25; // نقاط إضافية عند ترابط اسم دراسي مع فعل طلب مساعدة
	}

	// 2. خصم النقاط للتعبيرات السلبية (الإعلانية والمروجين)
	const matchedAds = adKeywords.filter(word => normalizedText.includes(word));
	score -= matchedAds.length * 40;

	// التحقق من تعبيرات التواصل التجاري
	if (normalizedText.includes('للتواصل خاص') || normalizedText.includes('تواصل خاص') || normalizedText.includes('راسلني خاص')) {
		score -= 35;
	}

	// التحقق من وجود رقم هاتف للتواصل التجاري (المروجين يضعون أرقام هواتفهم)
	const cleanDigitsOnly = normalizedText.replace(/\s+/g, '');
	const hasPhoneNumber = /(\+?96[67]\d{7,12})|(\b05\d{8}\b)|(\+\d{3,4}\d{3,4}\d{3,4})|(\d{7,15})/.test(cleanDigitsOnly);
	if (hasPhoneNumber && (matchedNouns.length > 0 || matchedVerbs.length > 0 || matchedAds.length > 0)) {
		score -= 50; // خصم نقاط كبير لحماية القناة من أرقام الترويج الخارجية
	}

	// التحقق من عروض مروجي الخدمات والشركات الخدمية
	const promoterTriggers = [
		'الي يبي', 'اللي يبي', 'من يبي', 'الي يحتاج', 'اللي يحتاج', 'من يحتاج',
		'يسوي واجبات', 'يسوي بحوث', 'يسوي مشاريع', 'يسوي تكاليف',
		'اقدر اجهز', 'اقدر احل', 'اقدر اسوي', 'شغلي مضمون', 'شغلي ثقه', 'ضمان الدرجه',
		'فل مارك', 'درجه كامله', 'الدرجه الكامله', 'يبشر بالخير', 'يبشر بالدرجه', 'وتواصل خاص'
	].map(normalizeArabicText);
	const matchedPromoter = promoterTriggers.filter(word => normalizedText.includes(word));
	if (matchedPromoter.length > 0) {
		score -= 50; // خصم نقاط قاطع لمنع المروجين تماماً
	}

	// 3. خصم نقاط عقابي للضحك والدردشة الجانبية لتفادي تجاوز الذكاء الاصطناعي (AI Bypass)
	const hasLaughter = /ه{3,}/.test(normalizedText) || normalizedText.includes('هههه') || normalizedText.includes('😂') || normalizedText.includes('🤣');
	if (hasLaughter) {
		score -= 40;
	}

	const chatWords = ['يا بنات', 'يا بنات القروب', 'حبيبتي', 'حبايب', 'ياخي', 'يا خي', 'صوصات', 'ابكي', 'أبكي', 'بموت', 'دموعي'].map(normalizeArabicText);
	const matchedChat = chatWords.filter(word => normalizedText.includes(word));
	if (matchedChat.length > 0) {
		score -= Math.min(45, matchedChat.length * 15);
	}

	// 4. تصنيف النية بناءً على النتيجة النهائية للنقاط
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
