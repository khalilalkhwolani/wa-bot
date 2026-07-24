export const config = {
	// اسم المجموعة المستهدفة لتوجيه روابط مجموعات واتساب
	TARGET_LINKS_GROUP: 'العمل',

	// اسم المجموعة المستهدفة لتوجيه طلبات مساعدة الطلاب (Leads)
	TARGET_LEADS_GROUP: 'طلبات الطلاب',

	// مفتاح Gemini API
	GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'AQ.Ab8RN6JBRB1fvWhTibqsPdcOLmaFe0eDhUkhQlhrtrUePNyeJA',

	// مفتاح Groq API (الرئيسي - llama-3.3-70b سريع ومجاني)
	GROQ_API_KEY: process.env.GROQ_API_KEY || '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',

	// مفتاح MiniMax API (بديل ثانوي)
	MINIMAX_API_KEY: process.env.MINIMAX_API_KEY || 'dahl_C6h9Xz53HBtjmT1kKK2GpPqoLvJvQW1Ki',

	// الجلسات النشطة للمراقبة (account_1 للقراءة فقط، account_2 للإرسال فقط)
	SESSIONS: ['account_1', 'account_2'],

	// الجلسة المسؤولة عن توجيه الرسائل والإرسال للمجموعات
	SENDER_SESSION: 'account_2',
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
