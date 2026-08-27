import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const [inputPath, outputDir] = process.argv.slice(2)
if (!inputPath || !outputDir) {
	throw new Error('Usage: node scripts/recover-whatsapp-links.mjs <chat.txt> <output-dir>')
}

const text = await fs.readFile(inputPath, 'utf8')
await fs.mkdir(outputDir, { recursive: true })

const messageHeader = /^(\d{1,2}\/\d{1,2}\/\d{2,4},\s+\d{1,2}:\d{2}[\s\u202f]*(?:AM|PM))\s+-\s+([^:\r\n]+):\s?/gm
const headers = [...text.matchAll(messageHeader)]
const messages = headers.map((match, index) => ({
	messageIndex: index + 1,
	timestampRaw: match[1].replace(/\u202f/g, ' '),
	sender: match[2].trim(),
	body: text.slice(match.index + match[0].length, headers[index + 1]?.index ?? text.length),
}))

const senderAliases = new Map()
const aliasFor = sender => {
	if (!senderAliases.has(sender)) senderAliases.set(sender, `sender_${senderAliases.size + 1}`)
	return senderAliases.get(sender)
}

const linkPattern = /https:\/\/(?:chat\.whatsapp\.com\/(?:invite\/)?|whatsapp\.com\/invite\/|whatsapp\.com\/channel\/)([A-Za-z0-9_-]+)/gi
const alertPattern = /رابط واتساب جديد\s*#(\d+)/g

function extractLinks(value) {
	return [...value.matchAll(linkPattern)].map(match => {
		const url = match[0]
		const code = match[1]
		const type = /whatsapp\.com\/channel\//i.test(url) ? 'channel' : 'group'
		return {
			url,
			code,
			canonicalKey: `${type}:${code.toLowerCase()}`,
			type,
			index: match.index,
		}
	})
}

const allOccurrences = []
const alertOccurrences = []

for (const message of messages) {
	const senderAlias = aliasFor(message.sender)
	const links = extractLinks(message.body)
	for (const [linkIndex, link] of links.entries()) {
		allOccurrences.push({
			messageIndex: message.messageIndex,
			linkIndex: linkIndex + 1,
			timestampRaw: message.timestampRaw,
			senderAlias,
			...link,
		})
	}

	const alerts = [...message.body.matchAll(alertPattern)]
	for (const [alertIndex, alert] of alerts.entries()) {
		const segmentStart = alert.index
		const segmentEnd = alerts[alertIndex + 1]?.index ?? message.body.length
		const segment = message.body.slice(segmentStart, segmentEnd)
		const segmentLinks = extractLinks(segment)
		const primaryLink = segmentLinks[0]
		const sourceMatch = segment.match(/(?:\*?المصدر:\*?)\s*([^\r\n]+)/)
		alertOccurrences.push({
			messageIndex: message.messageIndex,
			alertIndex: alertIndex + 1,
			timestampRaw: message.timestampRaw,
			senderAlias,
			serial: Number(alert[1]),
			source: sourceMatch?.[1]?.replace(/\*/g, '').trim() || '',
			url: primaryLink?.url || '',
			code: primaryLink?.code || '',
			canonicalKey: primaryLink?.canonicalKey || '',
			type: primaryLink?.type || '',
			segmentLinkCount: segmentLinks.length,
			confidence: primaryLink ? 'paired' : 'missing_link',
		})
	}
}

const sentByKey = new Map()
for (const row of alertOccurrences) {
	if (!row.canonicalKey) continue
	const existing = sentByKey.get(row.canonicalKey)
	if (!existing) {
		sentByKey.set(row.canonicalKey, {
			canonicalKey: row.canonicalKey,
			type: row.type,
			code: row.code,
			url: row.url,
			firstSerial: row.serial,
			lastSerial: row.serial,
			firstSeenAt: row.timestampRaw,
			lastSeenAt: row.timestampRaw,
			occurrences: 1,
			status: 'historically_sent',
		})
	} else {
		existing.lastSerial = row.serial
		existing.lastSeenAt = row.timestampRaw
		existing.occurrences += 1
	}
}

const allByKey = new Map()
for (const row of allOccurrences) {
	const existing = allByKey.get(row.canonicalKey)
	if (!existing) {
		allByKey.set(row.canonicalKey, {
			canonicalKey: row.canonicalKey,
			type: row.type,
			code: row.code,
			url: row.url,
			firstSeenAt: row.timestampRaw,
			lastSeenAt: row.timestampRaw,
			occurrences: 1,
			status: sentByKey.has(row.canonicalKey) ? 'historically_sent' : 'observed_unconfirmed',
		})
	} else {
		existing.lastSeenAt = row.timestampRaw
		existing.occurrences += 1
	}
}

const uniqueSentLinks = [...sentByKey.values()]
const uniqueAllLinks = [...allByKey.values()]
const observedUnconfirmed = uniqueAllLinks.filter(row => row.status === 'observed_unconfirmed')
const serials = alertOccurrences.map(row => row.serial).filter(Number.isFinite)
const distinctSerials = new Set(serials)
const repeatedSerials = [...new Set(serials.filter((serial, index) => serials.indexOf(serial) !== index))]

const sha256 = crypto.createHash('sha256').update(text).digest('hex')
const summary = {
	sourceFile: path.basename(inputPath),
	sourceSha256: sha256,
	messageCount: messages.length,
	allOfficialLinkOccurrences: allOccurrences.length,
	allUniqueOfficialLinks: uniqueAllLinks.length,
	alertOccurrences: alertOccurrences.length,
	alertsMissingLink: alertOccurrences.filter(row => !row.canonicalKey).length,
	uniqueHistoricallySentLinks: uniqueSentLinks.length,
	observedUnconfirmedUniqueLinks: observedUnconfirmed.length,
	minimumSerial: serials.length ? Math.min(...serials) : null,
	maximumSerial: serials.length ? Math.max(...serials) : null,
	distinctSerials: distinctSerials.size,
	repeatedSerials: repeatedSerials.length,
	recommendedNextDisplaySerial: serials.length ? Math.max(...serials) + 1 : 1,
	generatedAt: new Date().toISOString(),
	policy: {
		deleteNothing: true,
		allOccurrencesPreserved: true,
		confirmedSentDefinition: 'A WhatsApp link paired with a numbered bot alert segment.',
		unconfirmedDefinition: 'An official WhatsApp link observed in chat but not paired with a numbered bot alert segment.',
	},
}

function csvEscape(value) {
	const stringValue = value == null ? '' : String(value)
	return /[",\r\n]/.test(stringValue) ? `"${stringValue.replace(/"/g, '""')}"` : stringValue
}

async function writeCsv(filename, rows) {
	const columns = rows.length ? Object.keys(rows[0]) : []
	const lines = [columns.map(csvEscape).join(',')]
	for (const row of rows) lines.push(columns.map(column => csvEscape(row[column])).join(','))
	await fs.writeFile(path.join(outputDir, filename), `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8')
}

await Promise.all([
	fs.writeFile(path.join(outputDir, 'recovery-summary.json'), JSON.stringify(summary, null, 2), 'utf8'),
	fs.writeFile(path.join(outputDir, 'unique-historically-sent-links.json'), JSON.stringify(uniqueSentLinks, null, 2), 'utf8'),
	fs.writeFile(path.join(outputDir, 'all-unique-observed-links.json'), JSON.stringify(uniqueAllLinks, null, 2), 'utf8'),
	writeCsv('alert-occurrences.csv', alertOccurrences),
	writeCsv('all-link-occurrences.csv', allOccurrences),
	writeCsv('unique-historically-sent-links.csv', uniqueSentLinks),
	writeCsv('observed-unconfirmed-links.csv', observedUnconfirmed),
])

console.log(JSON.stringify(summary, null, 2))
