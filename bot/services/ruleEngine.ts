import { normalizeArabicSearch } from '../config'

// الكلمات المفتاحية الدراسية الأولية للفحص السريع للطلاب
const STUDY_KEYWORDS = [
	'واجب', 'حل', 'اختبار', 'امتحان', 'كويز', 'اسايمنت', 'مشروع', 'بروجكت', 
	'شرح', 'مساعده', 'يحل', 'يفهم', 'سؤال', 'سؤالين', 'مسأله', 'مسائل', 
	'دكتور', 'مبتلش', 'فزعتكم', 'تكفون', 'أبي', 'أبغا', 'أشتي', 'يشتي', 
	'ساعدوني', 'تساعدني', 'يساعدني', 'طريقه', 'مين يعرف', 'أحد يعرف', 'فزعه'
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

	// تجنب الرسائل التي تحتوي على إيموجيات فقط
	const emojiRegex = /^[\s\p{Emoji}\p{Extended_Pictographic}]+$/u
	if (emojiRegex.test(text)) return false

	// تجنب الرسائل التي تحتوي على روابط فقط
	if (text.trim().startsWith('http://') || text.trim().startsWith('https://')) return false

	const normalizedText = normalizeArabicSearch(text)

	// التحقق من وجود كلمة مفتاحية أكاديمية واحدة على الأقل
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
