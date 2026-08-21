export const config = {
	// معرف مجموعة "العمل" لتوجيه روابط مجموعات واتساب
	TARGET_LINKS_GROUP: process.env.TARGET_LINKS_GROUP || '120363406079474111@g.us',

	// معرف مجموعة "طلبات الطلاب" لتوجيه طلبات مساعدة الطلاب (Leads)
	TARGET_LEADS_GROUP: process.env.TARGET_LEADS_GROUP || '120363428139488465@g.us',

	// مفتاح Gemini API
	GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'AQ.Ab8RN6JBRB1fvWhTibqsPdcOLmaFe0eDhUkhQlhrtrUePNyeJA',

	// مفتاح Groq API (الرئيسي - llama-3.3-70b سريع ومجاني)
	GROQ_API_KEY: process.env.GROQ_API_KEY || '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',

	// مفتاح MiniMax API (بديل ثانوي)
	MINIMAX_API_KEY: process.env.MINIMAX_API_KEY || 'dahl_C6h9Xz53HBtjmT1kKK2GpPqoLvJvQW1Ki',

	// الجلسات النشطة
	SESSIONS: ['account_1', 'account_2'],

	// حساب القراءة فقط: يراقب القروبات المصدر ويلتقط الروابط/الطلبات
	READER_SESSION: 'account_2',

	// حساب الإرسال فقط: يرسل لمجموعة العمل / طلبات الطلاب — لا يقرأ رسائل المصدر
	SENDER_SESSION: 'account_1',

	// إيقاف أنبوب طلبات الطلاب مؤقتاً (SLIE) — الروابط تبقى شغّالة
	ENABLE_STUDENT_LEADS: false,
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
