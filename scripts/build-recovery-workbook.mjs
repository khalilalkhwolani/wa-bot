import fs from 'node:fs/promises'
import path from 'node:path'
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool'

const [recoveryOutputDir, finalOutputDir] = process.argv.slice(2)
if (!recoveryOutputDir || !finalOutputDir) {
	throw new Error('Usage: node scripts/build-recovery-workbook.mjs <recovery-output-dir> <final-output-dir>')
}

const readJson = async filename => JSON.parse(await fs.readFile(path.join(recoveryOutputDir, filename), 'utf8'))
const summary = await readJson('recovery-summary.json')
const confirmed = await readJson('unique-historically-sent-links.json')
const allUnique = await readJson('all-unique-observed-links.json')
const unconfirmed = allUnique.filter(row => row.status === 'observed_unconfirmed')

function parseCsv(text) {
	const rows = []
	let row = []
	let value = ''
	let quoted = false
	for (let i = 0; i < text.length; i++) {
		const char = text[i]
		if (quoted) {
			if (char === '"' && text[i + 1] === '"') {
				value += '"'
				i++
			} else if (char === '"') {
				quoted = false
			} else {
				value += char
			}
		} else if (char === '"') {
			quoted = true
		} else if (char === ',') {
			row.push(value)
			value = ''
		} else if (char === '\n') {
			row.push(value.replace(/\r$/, ''))
			rows.push(row)
			row = []
			value = ''
		} else {
			value += char
		}
	}
	if (value || row.length) {
		row.push(value)
		rows.push(row)
	}
	if (rows[0]?.[0]?.charCodeAt(0) === 0xfeff) rows[0][0] = rows[0][0].slice(1)
	return rows.filter(item => item.some(cell => cell !== ''))
}

const alertRows = parseCsv(await fs.readFile(path.join(recoveryOutputDir, 'alert-occurrences.csv'), 'utf8'))
const allOccurrenceRows = parseCsv(await fs.readFile(path.join(recoveryOutputDir, 'all-link-occurrences.csv'), 'utf8'))

const workbook = Workbook.create()
const summarySheet = workbook.worksheets.add('Summary')
const confirmedSheet = workbook.worksheets.add('Confirmed Sent')
const unconfirmedSheet = workbook.worksheets.add('Needs Review')
const alertsSheet = workbook.worksheets.add('Alert Occurrences')
const allSheet = workbook.worksheets.add('All Occurrences')

const titleFill = '#0F4C5C'
const headerFill = '#146C7E'
const accentFill = '#D9EEF2'
const warningFill = '#FFF0C2'
const bodyFont = '#172B34'

summarySheet.showGridLines = false
summarySheet.getRange('A1:F1').merge()
summarySheet.getRange('A1').values = [['تقرير إنقاذ روابط واتساب']]
summarySheet.getRange('A1:F1').format = {
	fill: titleFill,
	font: { bold: true, color: '#FFFFFF', fontSize: 18 },
	horizontalAlignment: 'center',
	verticalAlignment: 'center',
}
summarySheet.getRange('A1:F1').format.rowHeight = 34
summarySheet.getRange('A3:B13').values = [
	['المؤشر', 'القيمة'],
	['إجمالي مرات ظهور الروابط', summary.allOfficialLinkOccurrences],
	['كل الروابط الفريدة', summary.allUniqueOfficialLinks],
	['روابط مؤكدة الإرسال بتنبيه مرقّم', summary.uniqueHistoricallySentLinks],
	['روابط تحتاج مراجعة', summary.observedUnconfirmedUniqueLinks],
	['عدد التنبيهات المرقّمة', summary.alertOccurrences],
	['تنبيهات بلا رابط', summary.alertsMissingLink],
	['أقل رقم ظاهر', summary.minimumSerial],
	['أعلى رقم ظاهر', summary.maximumSerial],
	['عدد الأرقام المختلفة', summary.distinctSerials],
	['الرقم المقترح التالي بعد المراجعة', summary.recommendedNextDisplaySerial],
]
summarySheet.getRange('A3:B3').format = { fill: headerFill, font: { bold: true, color: '#FFFFFF' } }
summarySheet.getRange('A4:A13').format = { fill: accentFill, font: { color: bodyFont }, wrapText: true }
summarySheet.getRange('B4:B13').format = { font: { bold: true, color: bodyFont }, numberFormat: '#,##0' }
summarySheet.getRange('A3:B13').format.rowHeight = 26
summarySheet.getRange('A15:F15').merge()
summarySheet.getRange('A15').values = [[
	'قاعدة الأمان: لم يُحذف أي رابط. الروابط المؤكدة ارتبطت بتنبيه بوت مرقّم، والبقية محفوظة في ورقة Needs Review ولا تدخل الإنتاج قبل المراجعة.',
]]
summarySheet.getRange('A15:F15').format = { fill: warningFill, wrapText: true, font: { bold: true, color: '#5C4400' } }
summarySheet.getRange('A15:F15').format.rowHeight = 48
summarySheet.getRange('A17:B20').values = [
	['بيانات المصدر', 'القيمة'],
	['اسم الملف', summary.sourceFile],
	['SHA-256', summary.sourceSha256],
	['تاريخ إنشاء التقرير', summary.generatedAt],
]
summarySheet.getRange('A17:B17').format = { fill: headerFill, font: { bold: true, color: '#FFFFFF' } }
summarySheet.getRange('A3:B13').format.borders = { preset: 'outside', style: 'thin', color: '#9BBFC7' }
summarySheet.getRange('A17:B20').format.borders = { preset: 'outside', style: 'thin', color: '#9BBFC7' }
summarySheet.getRange('A:A').format.columnWidth = 55
summarySheet.getRange('B:B').format.columnWidth = 72
summarySheet.freezePanes.freezeRows(1)

function writeObjectSheet(sheet, rows, columns, tableName, warning = false) {
	sheet.showGridLines = false
	const matrix = [columns.map(column => column.label)]
	for (const row of rows) matrix.push(columns.map(column => row[column.key] ?? ''))
	const endColumn = columnName(columns.length)
	const endRow = Math.max(1, matrix.length)
	sheet.getRange(`A1:${endColumn}${endRow}`).values = matrix
	sheet.getRange(`A1:${endColumn}1`).format = {
		fill: warning ? '#A86A00' : headerFill,
		font: { bold: true, color: '#FFFFFF' },
		wrapText: true,
	}
	if (matrix.length > 1) {
		sheet.tables.add(`A1:${endColumn}${endRow}`, true, tableName)
	}
	sheet.freezePanes.freezeRows(1)
	if (endRow > 1) sheet.getRange(`A2:${endColumn}${Math.min(endRow, 200)}`).format.font = { color: bodyFont }
	for (let index = 0; index < columns.length; index++) {
		sheet.getRange(`${columnName(index + 1)}:${columnName(index + 1)}`).format.columnWidth = columns[index].width
	}
}

function writeMatrixSheet(sheet, matrix, tableName) {
	sheet.showGridLines = false
	if (!matrix.length) return
	const endColumn = columnName(matrix[0].length)
	const endRow = matrix.length
	sheet.getRange(`A1:${endColumn}${endRow}`).values = matrix
	sheet.getRange(`A1:${endColumn}1`).format = { fill: headerFill, font: { bold: true, color: '#FFFFFF' }, wrapText: true }
	sheet.tables.add(`A1:${endColumn}${endRow}`, true, tableName)
	sheet.freezePanes.freezeRows(1)
	for (let index = 1; index <= matrix[0].length; index++) {
		const width = index === 7 || index === 9 ? 48 : index === 6 ? 30 : 18
		sheet.getRange(`${columnName(index)}:${columnName(index)}`).format.columnWidth = width
	}
}

function columnName(number) {
	let result = ''
	while (number > 0) {
		number--
		result = String.fromCharCode(65 + (number % 26)) + result
		number = Math.floor(number / 26)
	}
	return result
}

const confirmedColumns = [
	{ key: 'canonicalKey', label: 'Canonical Key', width: 34 },
	{ key: 'type', label: 'Type', width: 12 },
	{ key: 'code', label: 'Code', width: 30 },
	{ key: 'url', label: 'URL', width: 52 },
	{ key: 'firstSerial', label: 'First Serial', width: 14 },
	{ key: 'lastSerial', label: 'Last Serial', width: 14 },
	{ key: 'firstSeenAt', label: 'First Seen', width: 24 },
	{ key: 'lastSeenAt', label: 'Last Seen', width: 24 },
	{ key: 'occurrences', label: 'Occurrences', width: 14 },
	{ key: 'status', label: 'Status', width: 22 },
]
const reviewColumns = [
	{ key: 'canonicalKey', label: 'Canonical Key', width: 34 },
	{ key: 'type', label: 'Type', width: 12 },
	{ key: 'code', label: 'Code', width: 30 },
	{ key: 'url', label: 'URL', width: 52 },
	{ key: 'firstSeenAt', label: 'First Seen', width: 24 },
	{ key: 'lastSeenAt', label: 'Last Seen', width: 24 },
	{ key: 'occurrences', label: 'Occurrences', width: 14 },
	{ key: 'status', label: 'Status', width: 22 },
]

writeObjectSheet(confirmedSheet, confirmed, confirmedColumns, 'ConfirmedSentTable')
writeObjectSheet(unconfirmedSheet, unconfirmed, reviewColumns, 'NeedsReviewTable', true)
writeMatrixSheet(alertsSheet, alertRows, 'AlertOccurrencesTable')
writeMatrixSheet(allSheet, allOccurrenceRows, 'AllOccurrencesTable')

await fs.mkdir(finalOutputDir, { recursive: true })
for (const sheetName of ['Summary', 'Confirmed Sent', 'Needs Review', 'Alert Occurrences', 'All Occurrences']) {
	const preview = await workbook.render({ sheetName, range: sheetName === 'Summary' ? 'A1:F20' : 'A1:J25', scale: 1, format: 'png' })
	await fs.writeFile(path.join(finalOutputDir, `.verify-${sheetName.replace(/\s+/g, '-').toLowerCase()}.png`), new Uint8Array(await preview.arrayBuffer()))
}

const output = await SpreadsheetFile.exportXlsx(workbook)
await output.save(path.join(finalOutputDir, 'whatsapp-links-recovery-report.xlsx'))

const inspection = await workbook.inspect({ kind: 'table', range: 'Summary!A1:F20', include: 'values,formulas', tableMaxRows: 20, tableMaxCols: 8 })
console.log(inspection.ndjson)
const errors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A', options: { useRegex: true, maxResults: 100 }, summary: 'final formula error scan' })
console.log(errors.ndjson)
