import { normalizeArabicSearch } from '../config'

// الكلمات المفتاحية الدراسية الأولية للفحص السريع للطلاب
const STUDY_KEYWORDS = [
	'واجب', 'حل', 'اختبار', 'امتحان', 'كويز', 'اسايمنت', 'مشروع', 'بروجكت', 
	'شرح', 'مساعده', 'يحل', 'يفهم', 'سؤال', 'سؤالين', 'مسأله', 'مسائل', 
	'دكتور', 'مبتلش', 'فزعتكم', 'تكفون', 'أبي', 'أبغا', 'أشتي', 'يشتي', 
	'ساعدوني', 'تساعدني', 'يساعدني', 'طريقه', 'مين يعرف', 'أحد يعرف', 'فزعه'
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

	// 6. التحقق من وجود كلمة مفتاحية أكاديمية واحدة على الأقل
	return STUDY_KEYWORDS.some(keyword => normalizedText.includes(keyword))
}

/**
 * فحص ما إذا كان نص الرسالة أو وصف المجموعة يحتوي على كلمات سبام محظورة لتصفية الروابط
 */
export function isSpamLinkText(text: string): boolean {
	if (!text) return false
	const normalizedText = normalizeArabicSearch(text)
	return BLACKLIST_KEYWORDS.some(keyword => normalizedText.includes(keyword))
}
