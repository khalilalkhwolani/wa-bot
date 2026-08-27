import path from 'path'

export const config = {
	// معرف مجموعة "العمل" — JID مباشر (أثبت من البحث بالاسم)
	TARGET_LINKS_GROUP: process.env.TARGET_LINKS_GROUP || '120363406079474111@g.us',

	// معرف مجموعة "طلبات الطلاب"
	TARGET_LEADS_GROUP: process.env.TARGET_LEADS_GROUP || '120363428139488465@g.us',

	// مفتاح Gemini API
	GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',

	// مفتاح Groq API (الرئيسي - llama-3.3-70b سريع ومجاني)
	GROQ_API_KEY: process.env.GROQ_API_KEY || '',

	// مفتاح MiniMax API (بديل ثانوي)
	MINIMAX_API_KEY: process.env.MINIMAX_API_KEY || '',

	// قاعدة الروابط الدائمة — تبقى معطلة محليًا حتى تُضبط أسرار بيئة التجربة
	SUPABASE_URL: process.env.SUPABASE_URL || '',
	SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
	LINK_STORAGE_BACKEND: process.env.LINK_STORAGE_BACKEND || 'supabase',
	LINK_FORWARDING_DRY_RUN: process.env.LINK_FORWARDING_DRY_RUN !== 'false',

	// الجلسات النشطة
	SESSIONS: ['account_1', 'account_2', 'account_3'],

	// الحساب الذي يرسل لمجموعة العمل (وحيد — لا بديل تلقائي)
	SENDER_SESSION: 'account_2',

	// حسابات مراقبة فقط: تقرأ وتلتقط الرسائل ولا يُسمح لها بالإرسال
	READ_ONLY_SESSIONS: ['account_1', 'account_3'],

	// إيقاف طلبات الطلاب — الروابط فقط
	ENABLE_STUDENT_LEADS: false,
}

/** مجلد الجلسات المحلي */
export const SESSIONS_DIR = process.env.SESSIONS_DIR || 'sessions'

export function getAuthFolder(sessionId: string): string {
	return path.join(SESSIONS_DIR, `auth_info_${sessionId}`)
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
