import path from 'path'

export const config = {
	// معرف مجموعة "العمل" — JID مباشر (أثبت من البحث بالاسم)
	TARGET_LINKS_GROUP: process.env.TARGET_LINKS_GROUP || '120363406079474111@g.us',

	// معرف مجموعة "طلبات الطلاب"
	TARGET_LEADS_GROUP: process.env.TARGET_LEADS_GROUP || '120363428139488465@g.us',

	// مفتاح Gemini API
	GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',

	// مفتاح Groq API (المصنف الوحيد للحالات الرمادية)
	GROQ_API_KEY: process.env.GROQ_API_KEY || '',
	// نموذج Groq — الافتراضي ما يتوافق مع مفاتيح الحسابات الحالية
	GROQ_MODEL: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',

	// مفتاح MiniMax API (بديل ثانوي)
	MINIMAX_API_KEY: process.env.MINIMAX_API_KEY || '',

	// قاعدة الروابط الدائمة — تبقى معطلة محليًا حتى تُضبط أسرار بيئة التجربة
	SUPABASE_URL: process.env.SUPABASE_URL || '',
	SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
	LINK_STORAGE_BACKEND: process.env.LINK_STORAGE_BACKEND || 'supabase',
	LINK_FORWARDING_DRY_RUN: process.env.LINK_FORWARDING_DRY_RUN !== 'false',

	// الحساب 3 متوقف حالياً حتى يعاد ربطه يدوياً. لا يبدأ تلقائياً كي لا يؤثر
	// على اتصال الحسابين العاملين. يمكن إضافته لاحقاً صراحة عبر BOT_SESSIONS.
	SESSIONS: (process.env.BOT_SESSIONS || 'account_1,account_2')
		.split(',')
		.map(s => s.trim())
		.filter(Boolean),

	// الحساب الذي يرسل لمجموعة العمل (وحيد — لا بديل تلقائي)
	SENDER_SESSION: 'account_1',

	// حسابات مراقبة فقط: تقرأ وتلتقط الرسائل ولا يُسمح لها بالإرسال
	READ_ONLY_SESSIONS: ['account_2', 'account_3'],

	// إيقاف طلبات الطلاب — الروابط فقط
	// لا يعمل هذا المسار إلا بتفعيل صريح من البيئة. لا تجعل قيمة افتراضية
	// تغيّر سلوك الإنتاج عند إعادة النشر.
	ENABLE_STUDENT_LEADS: process.env.ENABLE_STUDENT_LEADS === 'true',
	STUDENT_LEADS_MODE: process.env.STUDENT_LEADS_MODE === 'send'
		? 'send'
		: process.env.STUDENT_LEADS_MODE === 'dry-run'
			? 'dry-run'
			: 'disabled',
	// حتى في وضع send يلزم هذا المفتاح الثاني؛ حماية من تفعيل غير مقصود.
	STUDENT_LEADS_SEND_ENABLED: process.env.STUDENT_LEADS_SEND_ENABLED === 'true',
	STUDENT_LEADS_DEDUP_WINDOW_HOURS: Math.max(1, Number(process.env.STUDENT_LEADS_DEDUP_WINDOW_HOURS || 12)),
	STUDENT_LEADS_SENDER_COOLDOWN_HOURS: Math.max(1, Number(process.env.STUDENT_LEADS_SENDER_COOLDOWN_HOURS || 2)),

	// حزم جلسة متعددة الملفات قد تكون كبيرة جداً؛ لا تُنفذ أثناء فتح اتصال حي.
	// تؤخذ الحزمة اليدوية فقط بأمر pack-sessions أو عند تفعيل هذا الخيار صراحة.
	SESSION_BACKUP_ON_CONNECT: process.env.SESSION_BACKUP_ON_CONNECT === 'true',

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
