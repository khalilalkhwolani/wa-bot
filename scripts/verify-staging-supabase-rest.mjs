const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '')
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!baseUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')

const headers = {
	apikey: serviceKey,
	authorization: `Bearer ${serviceKey}`,
	prefer: 'count=exact',
}

const counterResponse = await fetch(`${baseUrl}/rest/v1/system_counters?select=counter_value&counter_key=eq.link_display_serial`, { headers })
if (!counterResponse.ok) throw new Error(`Counter check failed (${counterResponse.status})`)
const counters = await counterResponse.json()

const links = await exactCount('links')
const occurrences = await exactCount('link_occurrences')
const counter = Number(counters[0]?.counter_value)

if (links !== 5835 || occurrences !== 8158 || counter !== 1156) {
	throw new Error(`Unexpected staging totals: links=${links}, occurrences=${occurrences}, counter=${counter}`)
}

console.log(`SUPABASE_REST_OK links=${links} occurrences=${occurrences} counter=${counter}`)

async function exactCount(table) {
	const response = await fetch(`${baseUrl}/rest/v1/${table}?select=id&limit=1`, { headers })
	if (!response.ok) throw new Error(`${table} check failed (${response.status})`)
	const total = response.headers.get('content-range')?.split('/')[1]
	if (!total || total === '*') throw new Error(`No exact count returned for ${table}`)
	return Number(total)
}
