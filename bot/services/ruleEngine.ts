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

// تعبيرات طلب المساعدة ولهجات الفزعة (اليمنية والخليجية والعامة)
const HELP_EXPRESSIONS = [
	'فزعه', 'فزعتكم', 'تكفون', 'تكفى', 'افزعوا', 'ساعدوني', 'تساعدني', 'مساعده', 'مساعده',
	'ابي', 'ابغا', 'ابغى', 'أشتي', 'اشتي', 'يشتي', 'محتاج', 'محتاجه', 'مبتلش', 'متوهق',
	'ضايع', 'مش فاهم', 'مو فاهم', 'ما عرفت', 'ما فهمت', 'صعب علي', 'مين يعرف', 'أحد يعرف', 'احد يعرف',
	'مين يقدر', 'أحد يقدر', 'احد يقدر', 'مين يحل', 'أحد يحل', 'احد يحل', 'مين يمسك', 'أحد يمسك', 'احد يمسك',
	'من يحل', 'من يمسك', 'من يساعد', 'من يفهم', 'من يشرح', 'من يسوي', 'من يعرف', 'كيف احل', 'طريقة حل', 
	'شرح طريقة', 'ابغا فزعه', 'ابي فزعه', 'شلو واجب', 'امسكوا واجب', 'يسعفني'
].map(normalizeArabicSearch)

// عبارات إعلانية ترويجية واضحة يتم حظرها محلياً فوراً
const AD_KEYWORDS = [
	'خدمات طلابيه', 'خدمات اكاديميه', 'نوفر لكم', 'نقدم لكم', 'مستعدون', 
	'اسعار مناسبه', 'حلول مضمونه', 'شعارنا الامانه', 'مكتبه', 'أعذار طبيه', 
	'اعذار طبيه', 'كادر', 'للتواصل عبر', 'للتواصل واتساب', 'للتواصل خاص',
	'بحوث علميه', 'عروض بوربوينت', 'سكليف', 'تنويم', 'تقرير طبي', 'تقارير طبيه',
	'كشف طبي', 'سيره ذاتيه', 'بحوثات', 'مشاريع تخرج', 'برزنتيشن', 'تلخيص كتب'
].map(normalizeArabicSearch)

// الكلمات المفتاحية المحظورة للروابط (سبام وإعلانات الخدمات العامة)
const BLACKLIST_KEYWORDS = [
	'سكليف', 'غياب', 'اجازه', 'مرضيه', 'طبي', 'اعذار', 'غيابات', 
	'اجازات', 'مستشفي', 'مرضي', 'اعلان', 'إعلان', 'اعلانات', 'إعلانات',
	'تبرير', 'تقرير', 'تقارير', 'طبيب', 'عذر', 'عياده', 'صحي',
	'حل', 'اختبار', 'اختبارات', 'امتحان', 'امتحانات', 'واجب', 'واجبات', 
	'اسايمنت', 'بحوث', 'بحث', 'بروجكت', 'مشاريع', 'تلخيص', 'ملخصات', 
	'تفريغ', 'جواز', 'جوازات', 'جوازين', 'نقل معلومات', 'انجاز'
].map(normalizeArabicSearch)

/**
 * فلتر محلي سريع (Rule Engine) للتحقق من أن الرسالة مرشحة للتحليل بالذكاء الاصطناعي
 */
export function shouldAnalyzeStudentLead(text: string): boolean {
	if (!text || text.length < 15) return false

	// 1. تجنب الرسائل التي تحتوي على إيموجيات فقط
	const emojiRegex = /^[\s\p{Emoji}\p{Extended_Pictographic}]+$/u
	if (emojiRegex.test(text)) return false

	// 2. تجنب الرسائل التي تحتوي على روابط فقط
	if (text.trim().startsWith('http://') || text.trim().startsWith('https://')) return false

	const normalizedText = normalizeArabicSearch(text)

	// 3. كشف وحظر روابط التواصل الواتساب المباشرة (غالباً ما يستخدمها المعلنون للترويج)
	if (text.includes('wa.me/') || text.includes('wa.link/') || text.includes('api.whatsapp.com/send')) {
		return false
	}

	// 4. كشف وحظر القوائم النقطية أو الأسطر التي تبدأ برموز تعبيرية (إعلان الكتالوجات)
	const lines = text.split('\n')
	let symbolLines = 0
	for (const line of lines) {
		const trimmed = line.trim()
		if (trimmed) {
			// التحقق من بدء السطر برمز تعبيري أو مؤشر قائمة
			if (/^[\p{Emoji}\p{Extended_Pictographic}♦️🔹🔸📌✅☑️✔️•\-*]/u.test(trimmed)) {
				symbolLines++
			}
		}
	}
	if (symbolLines >= 3) {
		return false
	}

	// 5. كشف وحظر القوائم النقطية العامة
	const bulletPoints = (text.match(/[♦️🔹🔸📌✅•\-*]/g) || []).length
	if (bulletPoints >= 3) {
		return false
	}

	// 6. كشف وحظر العبارات الإعلانية الشهيرة
	const isAd = AD_KEYWORDS.some(keyword => normalizedText.includes(keyword))
	if (isAd) {
		return false
	}

	// 7. التحقق من وجود تعبير طلب مساعدة مباشر، أو وجود (اسم دراسي + فعل طلب مساعدة)
	const hasHelpExpression = HELP_EXPRESSIONS.some(keyword => normalizedText.includes(keyword))
	const hasStudyNoun = STUDY_NOUNS.some(keyword => normalizedText.includes(keyword))
	const hasHelpVerb = HELP_VERBS.some(keyword => normalizedText.includes(keyword))

	return hasHelpExpression || (hasStudyNoun && hasHelpVerb)
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
		'نشر روابط', 'تبادل روابط', 'حراج', 'شدات ببجي', 'زيادة متابعين', 
		'دعم متابعين', 'متابعين انستا', 'ربح', 'تداول', 'استثمار',
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
