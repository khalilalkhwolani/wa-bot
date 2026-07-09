export const config = {
	// اسم المجموعة المستهدفة لتوجيه روابط مجموعات واتساب
	TARGET_LINKS_GROUP: 'العمل',
	
	// اسم المجموعة المستهدفة لتوجيه طلبات مساعدة الطلاب (Leads)
	TARGET_LEADS_GROUP: 'طلبات الطلاب',
	
	// مفتاح Gemini API
	GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
	
	// الحسابات النشطة للمراقبة
	SESSIONS: ['account_1'],
}

/**
 * دالة مساعدة لتسهيل مطابقة أسماء المجموعات باللغة العربية (تتغاضى عن الهاء والتاء المربوطة والمسافات)
 */
export function normalizeArabic(text: string): string {
	if (!text) return ''
	return text
		.replace(/ة/g, 'ه')
		.replace(/\s+/g, '')
		.trim()
}

/**
 * دالة لتطبيع النصوص العربية للبحث والمطابقة الدقيقة للكلمات المفتاحية
 */
export function normalizeArabicSearch(text: string): string {
	if (!text) return ''
	return text
		.toLowerCase()
		.replace(/[أإآ]/g, 'ا')
		.replace(/ة/g, 'ه')
		.replace(/ى/g, 'ي')
		.trim()
}
