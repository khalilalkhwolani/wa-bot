import { config } from '../config'

export interface LinkIdentity {
	canonicalKey: string
	type: 'group' | 'channel'
	code: string
	url: string
}

export interface LinkClaim {
	linkId: string
	displaySerial: number | null
	shouldSend: boolean
	currentStatus: string
}

interface ClaimRow {
	link_id: string
	display_serial: number | string | null
	should_send: boolean
	current_status: string
}

export function parseWhatsAppLink(url: string): LinkIdentity | null {
	const match = /^https:\/\/(?:chat\.whatsapp\.com\/(?:invite\/)?|whatsapp\.com\/invite\/|whatsapp\.com\/channel\/)([A-Za-z0-9_-]+)/i.exec(url.trim())
	if (!match?.[1]) return null
	const type: LinkIdentity['type'] = /whatsapp\.com\/channel\//i.test(url) ? 'channel' : 'group'
	const code = match[1]
	return {
		canonicalKey: `${type}:${code.toLowerCase()}`,
		type,
		code,
		url: type === 'channel' ? `https://whatsapp.com/channel/${code}` : `https://chat.whatsapp.com/${code}`,
	}
}

export function isSupabaseLinkStoreConfigured(): boolean {
	return config.LINK_STORAGE_BACKEND === 'supabase' && Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY)
}

export async function claimLinkForSending(input: {
	link: LinkIdentity
	sessionId: string
	sourceGroupJid?: string
	sourceGroupName?: string
	sourceMessageId?: string
	sourceSenderJid?: string
	observedAt?: string
}): Promise<LinkClaim> {
	const rows = await rpc<ClaimRow[]>('claim_link_for_sending', {
		p_canonical_key: input.link.canonicalKey,
		p_link_type: input.link.type,
		p_invite_code: input.link.code,
		p_url: input.link.url,
		p_session_id: input.sessionId,
		p_source_group_jid: input.sourceGroupJid ?? null,
		p_source_group_name: input.sourceGroupName ?? null,
		p_source_message_id: input.sourceMessageId ?? null,
		p_source_sender_jid: input.sourceSenderJid ?? null,
		p_observed_at: input.observedAt ?? new Date().toISOString(),
	})
	const row = rows[0]
	if (!row) throw new Error('Supabase claim returned no row')
	return {
		linkId: row.link_id,
		displaySerial: row.display_serial == null ? null : Number(row.display_serial),
		shouldSend: row.should_send,
		currentStatus: row.current_status,
	}
}

export async function markLinkSent(linkId: string, whatsappMessageId: string): Promise<void> {
	await rpc('mark_link_sent', {
		p_link_id: linkId,
		p_whatsapp_message_id: whatsappMessageId,
		p_sent_at: new Date().toISOString(),
	})
}

export async function markLinkFailed(linkId: string, error: unknown): Promise<void> {
	await rpc('mark_link_failed', {
		p_link_id: linkId,
		p_error: String(error).slice(0, 2000),
	})
}

async function rpc<T = unknown>(functionName: string, body: Record<string, unknown>): Promise<T> {
	if (!isSupabaseLinkStoreConfigured()) throw new Error('Supabase link storage is not configured')
	const url = `${config.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${functionName}`
	const delays = [0, 750, 2000]
	let lastError: unknown

	for (let attempt = 0; attempt < delays.length; attempt++) {
		if (delays[attempt]) await new Promise(resolve => setTimeout(resolve, delays[attempt]))
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
				const message = (await response.text()).slice(0, 2000)
				const error = new Error(`Supabase RPC ${functionName} failed (${response.status}): ${message}`)
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

	const cause = lastError instanceof Error && lastError.cause ? `; cause=${String(lastError.cause)}` : ''
	throw new Error(`Supabase RPC ${functionName} failed after ${delays.length} attempts: ${String(lastError)}${cause}`)
}
