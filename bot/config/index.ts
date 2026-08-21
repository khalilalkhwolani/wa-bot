import path from 'path'

export type AccountRole = 'reader' | 'sender' | 'both'

export interface AccountConfig {
	id: string
	role: AccountRole
	phone?: string
}

/** مجلد الجلسات المحلي المؤقت (على Render المجاني يُفرَّغ عند Deploy — النسخة الدائمة عبر Upstash) */
export const SESSIONS_DIR = process.env.SESSIONS_DIR || 'sessions'

export function getAuthFolder(sessionId: string): string {
	return path.join(SESSIONS_DIR, `auth_info_${sessionId}`)
}

/**
 * سجل الحسابات — لإضافة حساب لاحقًا أضف عنصرًا هنا بنفس الشكل (بدون تغيير الأسماء الحالية).
 */
const ACCOUNTS: AccountConfig[] = [
	{
		id: 'account_1',
		role: 'sender',
		phone: process.env.PHONE_ACCOUNT_1 || '967776007366',
	},
	{
		id: 'account_2',
		role: 'reader',
		phone: process.env.PHONE_ACCOUNT_2 || '966579010262',
	},
]

function roleLabel(role: AccountRole): string {
	if (role === 'sender') return 'مرسل فقط'
	if (role === 'reader') return 'قارئ فقط'
	return 'قارئ ومرسل'
}

export const config = {
	SESSIONS_DIR,

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

	ACCOUNTS,

	/** معرفات الجلسات للتشغيل — مشتقة من السجل */
	get SESSIONS(): string[] {
		return ACCOUNTS.map(a => a.id)
	},

	/** حساب القراءة الافتراضي (أول قارئ في السجل) */
	get READER_SESSION(): string {
		const reader = ACCOUNTS.find(a => a.role === 'reader' || a.role === 'both')
		return reader?.id || ACCOUNTS[0]?.id || 'account_2'
	},

	/** حساب الإرسال الافتراضي (أول مرسل في السجل) */
	get SENDER_SESSION(): string {
		const sender = ACCOUNTS.find(a => a.role === 'sender' || a.role === 'both')
		return sender?.id || ACCOUNTS[0]?.id || 'account_1'
	},

	// إيقاف أنبوب طلبات الطلاب مؤقتاً (SLIE) — الروابط تبقى شغّالة
	ENABLE_STUDENT_LEADS: false,

	PHONE_NUMBERS: Object.fromEntries(
		ACCOUNTS.map(a => [a.id, a.phone || ''])
	) as Record<string, string>,
}

export function getAccount(sessionId: string): AccountConfig | undefined {
	return ACCOUNTS.find(a => a.id === sessionId)
}

export function isReaderSession(sessionId: string): boolean {
	const account = getAccount(sessionId)
	if (!account) return sessionId === config.READER_SESSION
	return account.role === 'reader' || account.role === 'both'
}

export function isSenderSession(sessionId: string): boolean {
	const account = getAccount(sessionId)
	if (!account) return sessionId === config.SENDER_SESSION
	return account.role === 'sender' || account.role === 'both'
}

export function getRoleLabel(sessionId: string): string {
	const account = getAccount(sessionId)
	return account ? roleLabel(account.role) : 'عام'
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
