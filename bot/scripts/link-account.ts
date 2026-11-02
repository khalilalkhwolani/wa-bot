import fs from 'fs'
import path from 'path'
import net from 'node:net'
import { getAuthFolder } from '../config'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import makeWASocket, {
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState
} from '../../src'
import { persistSessionPack, SESSION_PACKS_DIR } from '../services/sessionStore'

const sessionId = process.argv[2] || 'account_2'
if (!/^account_[1-9]\d*$/.test(sessionId)) throw new Error('Invalid account ID')
const guard = net.createServer()
await new Promise<void>((resolve, reject) => {
	guard.once('error', () => reject(new Error('أوقف البوت أو عملية الربط الأخرى أولاً؛ المنفذ مشغول. لم تتغير الجلسات.')))
	guard.listen(Number(process.env.PORT || 3000), resolve)
})

console.log(`\n════════════════════════════════════════════════════════════════════`)
console.log(`🔄 جاري تجهيز بيئة الربط للحساب: [${sessionId}]...`)
console.log(`════════════════════════════════════════════════════════════════════\n`)

const authFolder = getAuthFolder(sessionId)
const backupFile = path.join(SESSION_PACKS_DIR, `${sessionId}.json`)

// 1. تنظيف أي جلسة منتهية أو معطوبة قديمة لضمان توليد باركود جديد
if (fs.existsSync(authFolder) || fs.existsSync(backupFile)) {
	if (!process.argv.includes('--relink')) {
		console.error('الجلسة موجودة. استخدم المنيو لتأكيد إعادة الربط؛ لم تُحذف أي ملفات.')
		guard.close()
		process.exit(1)
	}
	fs.mkdirSync('recovery/session-archives', { recursive: true })
	const archive = fs.mkdtempSync(path.join('recovery/session-archives', 'relink-'))
	if (fs.existsSync(authFolder)) fs.renameSync(authFolder, path.join(archive, `auth_info_${sessionId}`))
	if (fs.existsSync(backupFile)) fs.renameSync(backupFile, path.join(archive, `${sessionId}.json`))
	console.log(`حُفظت الجلسة السابقة في ${archive}؛ لم تُحذف.`)
}
let attempts = 0
let finishing = false

async function startLinking() {
	fs.mkdirSync(authFolder, { recursive: true })

	const { state, saveCreds } = await useMultiFileAuthState(authFolder)
	const fetched = await fetchLatestBaileysVersion()
	const minRevision = 1046388543
	const version: [number, number, number] =
		fetched.version[2] >= minRevision ? fetched.version : [2, 3000, minRevision]

	const logger = P({ level: 'silent' })

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: false,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		generateHighQualityLinkPreview: false,
		syncFullHistory: false,
		shouldSyncHistoryMessage: () => false,
		markOnlineOnConnect: true,
		connectTimeoutMs: 120_000,
		defaultQueryTimeoutMs: 120_000,
	})

	sock.ev.on('creds.update', async () => {
		try {
			await saveCreds()
		} catch (err) {
			console.warn('⚠️ خطأ مؤقت في حفظ المفاتيح:', err)
		}
	})

	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, qr } = update

		if (qr) {
			console.log(`\n════════════════════════════════════════════════════════════════════`)
			console.log(`📸 امسح الباركود التالي من واتساب لربط الحساب: [${sessionId}]`)
			console.log(`👉 (افتح واتساب > الأجهزة المرتبطة > ربط جهاز)`)
			console.log(`⏱️  صلاحية الباركود: دقيقتان — امسحه قبل أن تنتهي المهلة`)
			console.log(`════════════════════════════════════════════════════════════════════\n`)
			qrcode.generate(qr, { small: true })
		}

		if (connection === 'close') {
			if (finishing) return
			sock.ev.removeAllListeners('connection.update')
			sock.ev.removeAllListeners('creds.update')
			const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
			if (statusCode === DisconnectReason.loggedOut || statusCode === 440 || ++attempts > 5) {
				console.error(`❌ تم رفض الجلسة أو تسجيل الخروج (401). يرجى المحاولة مجدداً.`)
				process.exit(1)
			} else {
				// الباركود انتهت صلاحيته أو انقطع الاتصال — ننتظر 5 ثوانٍ قبل توليد باركود جديد
				console.log(`\n⏳ انتهت صلاحية الباركود أو انقطع الاتصال.`)
				console.log(`   جاري توليد باركود جديد بعد 5 ثوانٍ... (اضغط Ctrl+C للإلغاء)\n`)
				await new Promise(r => setTimeout(r, 5_000))
				startLinking().catch(err => { console.error('فشل الربط:', err.message); process.exit(1) })
			}
		} else if (connection === 'open') {
			finishing = true
			console.log(`\n════════════════════════════════════════════════════════════════════`)
			console.log(`🎉✅ تم الاتصال بنجاح للحساب: [${sessionId}]!`)
			console.log(`════════════════════════════════════════════════════════════════════\n`)

			try {
				await saveCreds()
				if (!persistSessionPack(sessionId)) throw new Error('تعذر حفظ نسخة الجلسة')
			} catch (error) {
				console.error('فشل حفظ الربط؛ لا تعتبره مكتملًا:', error)
				process.exit(1)
			}
			console.log(`💾 تم حفظ الجلسة الجديدة وإنشاء حزمة النسخ الاحتياطي في sessions-backup/${sessionId}.json بنجاح!`)
			console.log(`\n🚀 يمكنك الآن تشغيل البوت بشكل طبيعي بكافة الحسابات عبر:\n   npm run bot:local\n`)

			// مهلة ثانية لحفظ الملفات بالكامل ثم الخروج بنجاح
			setTimeout(() => {
				sock.end(undefined)
				process.exit(0)
			}, 2000)
		}
	})
}

startLinking().catch(err => {
	console.error('❌ حدث خطأ غير متوقع أثناء تشغيل الربط:', err)
	process.exit(1)
})
