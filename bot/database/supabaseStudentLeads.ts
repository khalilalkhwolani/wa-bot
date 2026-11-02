import { createHash } from 'node:crypto'
import { config, normalizeArabicSearch } from '../config'

export type StudentLeadDecision = 'accepted' | 'review' | 'rejected'

export interface StudentLeadClaim {
	leadId: string
	displaySerial: number | null
	shouldDeliver: boolean
	currentStatus: string
}

interface ClaimRow {
	lead_id: string
	display_serial: number | string | null
	should_deliver: boolean
	current_status: string
}

export function isSupabaseStudentLeadStoreConfigured(): boolean {
	return Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY)
}

export function studentLeadFingerprint(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

export function normalizeStudentLeadContent(value: string): string {
	return normalizeArabicSearch(value)
		.replace(/[\u200e\u200f]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
}

export function buildStudentLeadSourceFingerprint(input: {
	sourceChatJid: string
	sourceSenderJid: string
	messageId: string
	observedAt?: string
	contentFingerprint: string
}): string {
	return studentLeadFingerprint(input.messageId
		? [input.sourceChatJid, input.messageId].join('|')
		: [input.sourceChatJid, input.sourceSenderJid, input.observedAt, input.contentFingerprint].join('|'))
}

/** يمنع إرسال أكثر من طلب لنفس الشخص خلال نافذة التهدئة، حتى لو غيّر صياغة الرسالة. */
export async function hasRecentDeliveredStudentLead(input: {
	studentPhone?: string
	sourceSenderJid?: string
	cooldownHours: number
}): Promise<boolean> {
	if (!isSupabaseStudentLeadStoreConfigured()) throw new Error('Supabase student lead storage is not configured')
	const phone = input.studentPhone?.trim()
	const senderJid = input.sourceSenderJid?.trim()
	if (!phone && !senderJid) return false

	const since = new Date(Date.now() - Math.max(1, input.cooldownHours) * 60 * 60 * 1000).toISOString()
	const url = new URL(`${config.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/student_leads`)
	url.searchParams.set('select', 'id')
	url.searchParams.set('status', 'in.(pending,sent,failed)')
	url.searchParams.set('last_observed_at', `gte.${since}`)
	url.searchParams.set(phone ? 'student_phone' : 'source_sender_jid', `eq.${phone || senderJid}`)
	url.searchParams.set('limit', '1')

	const response = await fetch(url, {
		headers: {
			apikey: config.SUPABASE_SERVICE_ROLE_KEY,
			authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
		},
		signal: AbortSignal.timeout(15_000),
	})
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 2_000)
		throw new Error(`Supabase recent student lead lookup failed (${response.status}): ${detail}`)
	}
	const rows = await response.json() as Array<{ id: string }>
	return rows.length > 0
}

export async function claimStudentLead(input: {
	decision: StudentLeadDecision
	sessionId: string
	messageId: string
	sourceChatJid: string
	sourceSenderJid: string
	sourceGroupInviteUrl?: string
	studentPhone?: string
	studentName?: string
	messageContent: string
	quotedContent?: string
	classification: string
	subject?: string
	confidence?: number
	score?: number
	reason?: string
	observedAt?: string
}): Promise<StudentLeadClaim> {
	const contentFingerprint = studentLeadFingerprint(normalizeStudentLeadContent(input.messageContent))
	// معرف الرسالة داخل القروب ثابت بين حسابات المراقبة؛ لا نضم المرسل لأن واتساب
	// قد يعرضه بصيغة phone في حساب وبصيغة LID في حساب آخر.
	const sourceFingerprint = buildStudentLeadSourceFingerprint({
		sourceChatJid: input.sourceChatJid,
		sourceSenderJid: input.sourceSenderJid,
		messageId: input.messageId,
		observedAt: input.observedAt,
		contentFingerprint,
	})
	const rows = await rpc<ClaimRow[]>('claim_student_lead', {
		p_source_fingerprint: sourceFingerprint,
		p_content_fingerprint: contentFingerprint,
		p_source_message_id: input.messageId || null,
		p_source_chat_jid: input.sourceChatJid || null,
		p_source_sender_jid: input.sourceSenderJid || null,
		p_source_session_id: input.sessionId,
		p_source_group_invite_url: input.sourceGroupInviteUrl || null,
		p_student_phone: input.studentPhone || null,
		p_student_name: input.studentName || null,
		p_message_content: input.messageContent,
		p_quoted_content: input.quotedContent || null,
		p_classification: input.classification,
		p_subject: input.subject || null,
		p_confidence: input.confidence ?? null,
		p_score: input.score ?? null,
		p_decision_reason: input.reason || null,
		p_decision: input.decision,
		p_dedup_window_hours: config.STUDENT_LEADS_DEDUP_WINDOW_HOURS,
		p_observed_at: input.observedAt || new Date().toISOString(),
	})
	const row = rows[0]
	if (!row) throw new Error('Supabase student lead claim returned no row')
	return {
		leadId: row.lead_id,
		displaySerial: row.display_serial == null ? null : Number(row.display_serial),
		shouldDeliver: row.should_deliver,
		currentStatus: row.current_status,
	}
}

export async function markStudentLeadSent(leadId: string, whatsappMessageId: string): Promise<void> {
	await rpc('mark_student_lead_sent', {
		p_lead_id: leadId,
		p_whatsapp_message_id: whatsappMessageId,
		p_sent_at: new Date().toISOString(),
	})
}

export async function markStudentLeadFailed(leadId: string, error: unknown): Promise<void> {
	await rpc('mark_student_lead_failed', {
		p_lead_id: leadId,
		p_error: String(error).slice(0, 2000),
	})
}

async function rpc<T = unknown>(functionName: string, body: Record<string, unknown>): Promise<T> {
	if (!isSupabaseStudentLeadStoreConfigured()) throw new Error('Supabase student lead storage is not configured')
	const url = `${config.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${functionName}`
	const delays = [0, 750, 2_000]
	let lastError: unknown
	for (const delay of delays) {
		if (delay) await new Promise(resolve => setTimeout(resolve, delay))
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					apikey: config.SUPABASE_SERVICE_ROLE_KEY,
					authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(15_000),
			})
			if (!response.ok) {
				const detail = (await response.text()).slice(0, 2_000)
				const error = new Error(`Supabase RPC ${functionName} failed (${response.status}): ${detail}`)
				if (response.status !== 429 && response.status < 500) throw error
				lastError = error
				continue
			}
			const text = await response.text()
			return (text ? JSON.parse(text) : undefined) as T
		} catch (error) {
			lastError = error
			if (error instanceof Error && error.message.startsWith(`Supabase RPC ${functionName} failed (4`)) throw error
		}
	}
	throw new Error(`Supabase RPC ${functionName} failed after ${delays.length} attempts: ${String(lastError)}`)
}
