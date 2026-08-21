import { normalizeArabicSearch } from '../config'

// الأسماء الدراسية والأكاديمية
const STUDY_NOUNS = [
	'واجب', 'واجبات', 'اختبار', 'اختبارات', 'امتحان', 'امتحانات', 'كويز', 'كويزات',
	'اسايمنت', 'اسايمنتات', 'بروجكت', 'بروجكتات', 'مشروع', 'مشاريع', 'تقرير', 'تقارير',
	'بحث', 'بحوث', 'تفريغ', 'ملخص', 'ملخصات', 'سلايدات', 'شابتر', 'شباتر', 'سؤال', 'سؤالين',
	'مسأله', 'مسائل', 'كود', 'أكواد', 'برمجه', 'فيزياء', 'كيمياء', 'رياضيات', 'احصاء',
	'محاسبه', 'قواعد بيانات', 'شبكات', 'انجليزي', 'تعبير', 'ميد', 'فاينل'
].map(normalizeArabicSearch)

// أفعال طلب المساعدة الأكاديمية
const HELP_VERBS = [
	'يساعدني', 'تساعدني', 'يساعد', 'تساعد', 'يحل', 'تحل', 'يسوي', 'تسوي', 'يفهم', 'تفهم',
	'يشرح', 'تشرح', 'يمسك', 'تمسك', 'يضبط', 'تضبط', 'يسعف', 'ينقذ', 'يعرف', 'تعرف',
	'يقدر', 'تقدر', 'يفزع', 'تفزع', 'يدرس', 'تدرس'
].map(normalizeArabicSearch)

// تعبيرات طلب مساعدة قوية فقط (بدون ابي/ابغى/اشتي لأنها كلمات يومية)
const HELP_EXPRESSIONS = [
	'فزعه', 'فزعتكم', 'تكفون', 'تكفى', 'افزعوا', 'ساعدوني', 'تساعدني', 'مساعده',
	'محتاج', 'محتاجه', 'مبتلش', 'متوهق',
	'ضايع', 'مش فاهم', 'مو فاهم', 'ما عرفت', 'ما فهمت', 'صعب علي', 'مين يعرف', 'أحد يعرف', 'احد يعرف',
	'مين يقدر', 'أحد يقدر', 'احد يقدر', 'مين يحل', 'أحد يحل', 'احد يحل', 'مين يمسك', 'أحد يمسك', 'احد يمسك',
	'من يحل', 'من يمسك', 'من يساعد', 'من يفهم', 'من يشرح', 'من يسوي', 'من يعرف', 'كيف احل', 'طريقة حل',
	'شرح طريقة', 'ابغا فزعه', 'ابي فزعه', 'شلو واجب', 'امسكوا واجب', 'يسعفني'
].map(normalizeArabicSearch)

// كلمات رغبة ضعيفة: لا تكفي وحدها — تحتاج سياق دراسي
const WEAK_DESIRE_WORDS = [
	'ابي', 'ابغا', 'ابغى', 'أشتي', 'اشتي', 'يشتي'
].map(normalizeArabicSearch)

// عبارات إعلانية ترويجية واضحة يتم حظرها محلياً فوراً
const AD_KEYWORDS = [
	'خدمات طلابيه', 'خدمات اكاديميه', 'نوفر لكم', 'نقدم لكم', 'مستعدون', 
	'اسعار مناسبه', 'حلول مضمونه', 'شعارنا الامانه', 'مكتبه', 'أعذار طبيه', 
	'اعذار طبيه', 'كادر', 'للتواصل عبر', 'للتواصل واتساب', 'للتواصل خاص',
	'بحوث علميه', 'عروض بوربوينت', 'سكليف', 'تنويم', 'تقرير طبي', 'تقارير طبيه',
	'كشف طبي', 'سيره ذاتيه', 'بحوثات', 'مشاريع تخرج', 'برزنتيشن', 'تلخيص كتب'
].map(normalizeArabicSearch)

// الكلمات المفتاحية المحظورة للروابط (سبام وإعلانات الخدمات غير الدراسية)
const BLACKLIST_KEYWORDS = [
	'سكليف', 'مرضي', 'مرضيه', 'مرضية', 'سكليف مرضي', 'سكليف مرضية', 'سكليف مرضيه',
	'غياب', 'اجازه', 'طبي', 'اعذار', 'غيابات', 'اعذار طبيه', 'اعذار طبية',
	'اجازات', 'مستشفي', 'اعلان', 'إعلان', 'اعلانات', 'إعلانات',
	'تبرير', 'طبيب', 'عذر', 'عياده', 'صحي',
	'جواز', 'جوازات', 'جوازين', 'نقل معلومات', 'انجاز'
].map(normalizeArabicSearch)

function stripBotMarkers(text: string): string {
	return (text || '')
		.replace(/▫️\s*/g, '')
		.replace(/↪️\s*/g, '')
		.trim()
}

/**
 * طبقة أ: رفض هيكلي رخيص (رابط/إعلان/رسالة فارغة) بدون تحليل دلالي
 */
export function passesStructuralLeadGate(text: string): boolean {
	const cleaned = stripBotMarkers(text)
	if (!cleaned || cleaned.length < 8) return false

	const emojiRegex = /^[\s\p{Emoji}\p{Extended_Pictographic}]+$/u
	if (emojiRegex.test(cleaned)) return false

	if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) return false

	if (cleaned.includes('wa.me/') || cleaned.includes('wa.link/') || cleaned.includes('api.whatsapp.com/send')) {
		return false
	}

	const lines = cleaned.split('\n')
	let symbolLines = 0
	for (const line of lines) {
		const trimmed = line.trim()
		if (trimmed && /^[\p{Emoji}\p{Extended_Pictographic}♦️🔹🔸📌✅☑️✔️•\-*]/u.test(trimmed)) {
			symbolLines++
		}
	}
	if (symbolLines >= 3) return false

	const bulletPoints = (cleaned.match(/[♦️🔹🔸📌✅•\-*]/g) || []).length
	if (bulletPoints >= 3) return false

	const normalizedText = normalizeArabicSearch(cleaned)
	if (AD_KEYWORDS.some(keyword => normalizedText.includes(keyword))) return false

	return true
}

/**
 * طبقة ب: إشارات أكاديمية كميزات وليست قراراً نهائياً
 */
export function hasAcademicHelpSignal(text: string): boolean {
	const cleaned = stripBotMarkers(text)
	if (!cleaned) return false

	const normalizedText = normalizeArabicSearch(cleaned)
	const hasHelpExpression = HELP_EXPRESSIONS.some(keyword => normalizedText.includes(keyword))
	const hasStudyNoun = STUDY_NOUNS.some(keyword => normalizedText.includes(keyword))
	const hasHelpVerb = HELP_VERBS.some(keyword => normalizedText.includes(keyword))
	const hasWeakDesire = WEAK_DESIRE_WORDS.some(keyword => normalizedText.includes(keyword))

	return (
		hasHelpExpression ||
		(hasStudyNoun && hasHelpVerb) ||
		(hasWeakDesire && (hasStudyNoun || hasHelpVerb))
	)
}

/**
 * توافق خلفي: هيكل سليم + إشارة أكاديمية في النص نفسه
 */
export function shouldAnalyzeStudentLead(text: string): boolean {
	return passesStructuralLeadGate(text) && hasAcademicHelpSignal(text)
}

/**
 * فحص ما إذا كان نص الرسالة أو وصف المجموعة يحتوي على كلمات سبام محظورة لتصفية الروابط
 */
export function isSpamLinkText(text: string): boolean {
	if (!text) return false
	const normalizedText = normalizeArabicSearch(text)

	// 1. التحقق من الكلمات المحظورة التقليدية (السبام والخدمات العامة)
	const hasBlacklistKeyword = BLACKLIST_KEYWORDS.some(keyword => normalizedText.includes(keyword))
	if (hasBlacklistKeyword) return true

	// 2. التحقق من العبارات الإعلانية للخدمات الأكاديمية التجارية
	const AD_KEYWORDS_FOR_LINKS = [
		'خدمات طلابيه', 'خدمات اكاديميه', 'خدمات طلابية', 'خدمات أكاديمية',
		'نوفر لكم', 'نقدم لكم', 'مستعدون', 'مستعدين', 'حلول مضمونه', 'حلول مضمونة',
		'اسعار مناسبه', 'أسعار مناسبة', 'شعارنا الامانه', 'شعارنا الأمانة',
		'مكتبه', 'مكتبة', 'مكتب التميز', 'مكتبة التميز', 'كادر', 'قروب للحل', 'مجموعة للحل',
		'للتواصل عبر', 'للتواصل واتساب', 'للتواصل خاص', 'راسلني خاص', 'تواصل خاص',
		'بحوث علميه', 'بحوث علمية', 'عروض بوربوينت', 'مشاريع تخرج', 'سيره ذاتيه', 'سيرة ذاتية'
	].map(normalizeArabicSearch)

	const hasAdKeyword = AD_KEYWORDS_FOR_LINKS.some(keyword => normalizedText.includes(keyword))
	if (hasAdKeyword) return true

	// 3. التحقق من كلمات غير دراسية / سبام عام
	const GENERAL_SPAM_KEYWORDS = [
		'تعارف', 'سهرة', 'سهرات', 'دردشة', 'دردشه',
		'ضحك', 'وناسة', 'وناسه', 'فله', 'فلة', 'قروب نشر', 'قروب تبادل',
		'نشر روابط', 'تبادل روابط', 'نشر الروابط', 'تبادل الروابط', 'تبادل مجموعات', 
		'تبادل القروبات', 'انشر رابطك', 'انشر قروبك', 'انشروا', 'حراج', 'شدات ببجي', 
		'زيادة متابعين', 'دعم متابعين', 'متابعين انستا', 'ربح', 'تداول', 'استثمار',
		'منصة', 'بروموكود', 'كود خصم', 'كوبون', 'وظائف', 'وظايف', 'توظيف'
	].map(normalizeArabicSearch)

	const hasGeneralSpam = GENERAL_SPAM_KEYWORDS.some(keyword => normalizedText.includes(keyword))
	if (hasGeneralSpam) return true

	// 4. التحقق من وجود رقم هاتف أو رابط اتصال مباشر (المعلنون يضعون أرقامهم أو روابط wa.me للطلب المباشر)
	if (text.includes('wa.me/') || text.includes('wa.link/') || text.includes('api.whatsapp.com/send')) {
		return true
	}
	const cleanDigitsOnly = text.replace(/\s+/g, '')
	const hasPhoneNumber = /(\+?96[67]\d{7,12})|(\b05\d{8}\b)/.test(cleanDigitsOnly)
	if (hasPhoneNumber) {
		return true
	}

	// 5. التحقق من البصمة الهيكلية للإعلان (تعدد رموز القوائم والنقاط في رسالة الرابط)
	const lines = text.split('\n')
	let symbolLines = 0
	for (const line of lines) {
		const trimmed = line.trim()
		if (trimmed) {
			if (/^[\p{Emoji}\p{Extended_Pictographic}♦️🔹🔸📌✅☑️✔️•\-*]/u.test(trimmed)) {
				symbolLines++
			}
		}
	}
	if (symbolLines >= 3) return true

	const bulletPoints = (text.match(/[♦️🔹🔸📌✅•\-*]/g) || []).length
	if (bulletPoints >= 4) return true

	return false
}
