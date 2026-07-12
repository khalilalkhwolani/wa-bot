/**
 * محرك التطهير والتوحيد (Engine 1: Normalizer)
 */

/**
 * تطبيع الحروف العربية وتوحيدها لتسهيل الفحص اللغوي الدقيق
 */
export function normalizeArabicText(text: string): string {
	if (!text) return '';
	return text
		// إزالة رموز البوت الداخلية التي يضيفها contextBuilder (▫️ للرسائل العادية و ↪️ للردود)
		.replace(/▫️\s*/g, '')
		.replace(/↪️\s*/g, '')
		.toLowerCase()
		.replace(/[أإآ]/g, 'ا')
		.replace(/ة/g, 'ه')
		.replace(/ى/g, 'ي')
		.replace(/[\u064b-\u065f]/g, '') // إزالة التشكيل بالكامل
		.trim();
}

/**
 * دالة مبسطة لتطبيع الأسماء (إزالة الفراغات والتاء المربوطة)
 */
export function normalizeGroupName(name: string): string {
	if (!name) return '';
	return name
		.replace(/ة/g, 'ه')
		.replace(/\s+/g, '')
		.toLowerCase()
		.trim();
}
