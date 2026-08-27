import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const [recoveryDir = 'recovery/2026-08-27-whatsapp-export/outputs', outputPath = 'supabase/migrations/002_import_recovered_links.sql'] = process.argv.slice(2)

const summary = JSON.parse(await fs.readFile(path.join(recoveryDir, 'recovery-summary.json'), 'utf8'))
const allLinks = JSON.parse(await fs.readFile(path.join(recoveryDir, 'all-unique-observed-links.json'), 'utf8'))
const sentLinks = JSON.parse(await fs.readFile(path.join(recoveryDir, 'unique-historically-sent-links.json'), 'utf8'))
const occurrences = parseCsv(await fs.readFile(path.join(recoveryDir, 'all-link-occurrences.csv'), 'utf8'))

if (allLinks.length !== summary.allUniqueOfficialLinks) throw new Error(`Unique link total mismatch: ${allLinks.length}`)
if (sentLinks.length !== summary.uniqueHistoricallySentLinks) throw new Error(`Historically sent total mismatch: ${sentLinks.length}`)
if (occurrences.length !== summary.allOfficialLinkOccurrences) throw new Error(`Occurrence total mismatch: ${occurrences.length}`)

const sentByKey = new Map(sentLinks.map(link => [link.canonicalKey, link]))
const canonicalKeys = new Set(allLinks.map(link => link.canonicalKey))
if (canonicalKeys.size !== allLinks.length) throw new Error('Duplicate canonical keys in recovery input')
for (const link of sentLinks) {
	if (!canonicalKeys.has(link.canonicalKey)) throw new Error(`Sent link missing from all-links set: ${link.canonicalKey}`)
}

const sql = [
	'begin;',
	'',
	`-- Recovery source SHA-256: ${summary.sourceSha256}`,
	`-- Expected: ${summary.allUniqueOfficialLinks} unique links and ${summary.allOfficialLinkOccurrences} occurrences.`,
	`-- Historical display numbers are evidence only; new live numbering starts after ${summary.maximumSerial}.`,
	'',
]

for (const batch of chunks(allLinks, 400)) {
	const rows = batch.map(link => {
		const sent = sentByKey.get(link.canonicalKey)
		const status = sent ? 'historically_sent' : 'observed_unconfirmed'
		const firstObserved = parseWhatsAppTimestamp(link.firstSeenAt)
		const lastObserved = parseWhatsAppTimestamp(link.lastSeenAt)
		const firstSent = sent ? parseWhatsAppTimestamp(sent.firstSeenAt) : null
		const lastSent = sent ? parseWhatsAppTimestamp(sent.lastSeenAt) : null
		return `(${[
			sqlString(link.canonicalKey),
			sqlString(link.type),
			sqlString(link.code),
			sqlString(link.url),
			sqlString(status),
			sqlNumber(sent?.firstSerial),
			sqlNumber(sent?.lastSerial),
			sqlNumber(link.occurrences),
			sqlTimestamp(firstObserved),
			sqlTimestamp(lastObserved),
			sqlTimestamp(firstSent),
			sqlTimestamp(lastSent),
			sqlJson({ recoverySourceSha256: summary.sourceSha256, recoveryStatus: status }),
		].join(', ')})`
	})

	sql.push(
		'insert into public.links (canonical_key, link_type, invite_code, url, status, legacy_first_serial, legacy_last_serial, occurrence_count, first_observed_at, last_observed_at, first_sent_at, last_sent_at, metadata)',
		'values',
		`${rows.join(',\n')}`,
		'on conflict (canonical_key) do update set',
		"  status = case when public.links.status in ('sent', 'historically_sent') or excluded.status = 'historically_sent' then 'historically_sent' else public.links.status end,",
		'  legacy_first_serial = least(public.links.legacy_first_serial, excluded.legacy_first_serial),',
		'  legacy_last_serial = greatest(public.links.legacy_last_serial, excluded.legacy_last_serial),',
		'  occurrence_count = greatest(public.links.occurrence_count, excluded.occurrence_count),',
		'  first_observed_at = least(public.links.first_observed_at, excluded.first_observed_at),',
		'  last_observed_at = greatest(public.links.last_observed_at, excluded.last_observed_at),',
		'  first_sent_at = coalesce(least(public.links.first_sent_at, excluded.first_sent_at), public.links.first_sent_at, excluded.first_sent_at),',
		'  last_sent_at = coalesce(greatest(public.links.last_sent_at, excluded.last_sent_at), public.links.last_sent_at, excluded.last_sent_at),',
		'  metadata = public.links.metadata || excluded.metadata;',
		'',
	)
}

for (const batch of chunks(occurrences, 500)) {
	const rows = batch.map(row => {
		const fingerprint = crypto.createHash('sha256')
			.update(`${summary.sourceSha256}|${row.messageIndex}|${row.linkIndex}|${row.index}|${row.canonicalKey}`)
			.digest('hex')
		return `(${[
			sqlString(row.canonicalKey),
			sqlString(fingerprint),
			sqlTimestamp(parseWhatsAppTimestamp(row.timestampRaw)),
			sqlString('recovery_whatsapp_export_2026_08_27'),
			sqlString(`recovery-message-${row.messageIndex}`),
			sqlString(row.url),
			sqlJson({
				recoverySourceSha256: summary.sourceSha256,
				messageIndex: Number(row.messageIndex),
				linkIndex: Number(row.linkIndex),
				senderAlias: row.senderAlias,
			}),
		].join(', ')})`
	})

	sql.push(
		'insert into public.link_occurrences (link_id, event_fingerprint, observed_at, session_id, source_message_id, raw_url, outcome, metadata)',
		'select l.id, v.event_fingerprint, v.observed_at, v.session_id, v.source_message_id, v.raw_url, \'historical_import\', v.metadata',
		'from (values',
		`${rows.join(',\n')}`,
		') as v(canonical_key, event_fingerprint, observed_at, session_id, source_message_id, raw_url, metadata)',
		'join public.links l on l.canonical_key = v.canonical_key',
		'on conflict (event_fingerprint) do nothing;',
		'',
	)
}

sql.push(
	'update public.system_counters',
	`set counter_value = greatest(counter_value, ${summary.maximumSerial})`,
	"where counter_key = 'link_display_serial';",
	'',
	'do $$',
	'declare',
	'  v_links bigint;',
	'  v_sent bigint;',
	'  v_unconfirmed bigint;',
	'  v_occurrences bigint;',
	'  v_counter bigint;',
	'begin',
	`  select count(*) into v_links from public.links where metadata->>'recoverySourceSha256' = ${sqlString(summary.sourceSha256)};`,
	`  select count(*) into v_sent from public.links where metadata->>'recoverySourceSha256' = ${sqlString(summary.sourceSha256)} and status = 'historically_sent';`,
	`  select count(*) into v_unconfirmed from public.links where metadata->>'recoverySourceSha256' = ${sqlString(summary.sourceSha256)} and status = 'observed_unconfirmed';`,
	`  select count(*) into v_occurrences from public.link_occurrences where metadata->>'recoverySourceSha256' = ${sqlString(summary.sourceSha256)};`,
	"  select counter_value into v_counter from public.system_counters where counter_key = 'link_display_serial';",
	`  if v_links <> ${summary.allUniqueOfficialLinks} or v_sent <> ${summary.uniqueHistoricallySentLinks} or v_unconfirmed <> ${summary.observedUnconfirmedUniqueLinks} or v_occurrences <> ${summary.allOfficialLinkOccurrences} or v_counter < ${summary.maximumSerial} then`,
	"    raise exception 'Recovery verification failed: links %, sent %, unconfirmed %, occurrences %, counter %', v_links, v_sent, v_unconfirmed, v_occurrences, v_counter;",
	'  end if;',
	'end;',
	'$$;',
	'',
	'commit;',
	'',
)

await fs.mkdir(path.dirname(outputPath), { recursive: true })
await fs.writeFile(outputPath, sql.join('\n'), 'utf8')

console.log(JSON.stringify({
	outputPath,
	sourceSha256: summary.sourceSha256,
	uniqueLinks: allLinks.length,
	historicallySent: sentLinks.length,
	observedUnconfirmed: allLinks.length - sentLinks.length,
	occurrences: occurrences.length,
	counterFloor: summary.maximumSerial,
}, null, 2))

function chunks(values, size) {
	const result = []
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
	return result
}

function sqlString(value) {
	if (value == null || value === '') return 'null'
	return `'${String(value).replace(/'/g, "''")}'`
}

function sqlNumber(value) {
	return Number.isFinite(Number(value)) ? String(Number(value)) : 'null'
}

function sqlTimestamp(value) {
	return value ? `${sqlString(value)}::timestamptz` : 'null'
}

function sqlJson(value) {
	return `${sqlString(JSON.stringify(value))}::jsonb`
}

function parseWhatsAppTimestamp(value) {
	const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(value.replace(/\u202f/g, ' ').trim())
	if (!match) throw new Error(`Unsupported WhatsApp timestamp: ${value}`)
	let [, month, day, year, hour, minute, meridiem] = match
	year = year.length === 2 ? `20${year}` : year
	let hourNumber = Number(hour) % 12
	if (meridiem.toUpperCase() === 'PM') hourNumber += 12
	return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${String(hourNumber).padStart(2, '0')}:${minute}:00+03:00`
}

function parseCsv(text) {
	const rows = []
	let row = []
	let field = ''
	let quoted = false
	const source = text.replace(/^\uFEFF/, '')
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]
		if (quoted) {
			if (character === '"' && source[index + 1] === '"') {
				field += '"'
				index += 1
			} else if (character === '"') quoted = false
			else field += character
		} else if (character === '"') quoted = true
		else if (character === ',') {
			row.push(field)
			field = ''
		} else if (character === '\n') {
			row.push(field.replace(/\r$/, ''))
			rows.push(row)
			row = []
			field = ''
		} else field += character
	}
	if (field || row.length) {
		row.push(field.replace(/\r$/, ''))
		rows.push(row)
	}
	const [headers, ...data] = rows.filter(candidate => candidate.some(value => value !== ''))
	return data.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])))
}
