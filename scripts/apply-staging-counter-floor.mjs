const expectedProjectRef = 'vwwudtzxjnhkaxujrxge'
const expectedUrl = `https://${expectedProjectRef}.supabase.co`
const counterFloor = 1365

const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '')
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (url !== expectedUrl) throw new Error(`Safety check failed: expected staging URL ${expectedUrl}`)
if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing')

const headers = {
	apikey: key,
	authorization: `Bearer ${key}`,
	'content-type': 'application/json',
	prefer: 'return=representation',
}

const patchUrl = `${url}/rest/v1/system_counters?counter_key=eq.link_display_serial&counter_value=lt.${counterFloor}`
const response = await fetch(patchUrl, {
	method: 'PATCH',
	headers,
	body: JSON.stringify({ counter_value: counterFloor, updated_at: new Date().toISOString() }),
	signal: AbortSignal.timeout(15_000),
})
if (!response.ok) throw new Error(`Counter update failed (${response.status}): ${(await response.text()).slice(0, 1000)}`)

const verify = await fetch(
	`${url}/rest/v1/system_counters?select=counter_value&counter_key=eq.link_display_serial&limit=1`,
	{ headers, signal: AbortSignal.timeout(15_000) }
)
if (!verify.ok) throw new Error(`Counter verification failed (${verify.status})`)
const [row] = await verify.json()
if (!row || Number(row.counter_value) < counterFloor) {
	throw new Error(`Counter verification failed: ${row?.counter_value ?? 'missing'} < ${counterFloor}`)
}
console.log(`STAGING_COUNTER_READY current=${row.counter_value} next=${Number(row.counter_value) + 1}`)
