import makeWASocket, { 
	fetchLatestBaileysVersion, 
	makeCacheableSignalKeyStore, 
	useMultiFileAuthState 
} from '../src'
import P from 'pino'
import path from 'path'

const logger = P({
	level: 'info',
	transport: {
		target: 'pino-pretty',
		options: { colorize: true }
	}
})

const TARGET_GROUP_NAME = 'العمل'
const SESSION_ID = 'account_1'
const TEST_LINK = 'https://chat.whatsapp.com/TESTLINK123456789'

async function runTest() {
	logger.info(`🧪 بدء اختبار الإرسال الحقيقي للحساب [${SESSION_ID}]...`)

	const authFolder = path.join('sessions', `auth_info_${SESSION_ID}`)
	const { state, saveCreds } = await useMultiFileAuthState(authFolder)
	const { version } = await fetchLatestBaileysVersion()

	const sock = makeWASocket({
		version,
		logger,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		printQRInTerminal: false,
		syncFullHistory: false,
	})

	sock.ev.on('creds.update', saveCreds)

	sock.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect } = update

		if (connection === 'close') {
			logger.error(`❌ انقطع الاتصال أثناء الاختبار: ${lastDisconnect?.error}`)
			process.exit(1)
		}

		if (connection === 'open') {
			logger.info(`🎉 تم الاتصال بنجاح! جاري البحث عن مجموعة "${TARGET_GROUP_NAME}"...`)

			try {
				const groups = await sock.groupFetchAllParticipating()
				let foundJid = ''

				for (const jid in groups) {
					const subject = groups[jid].subject
					if (subject === TARGET_GROUP_NAME || subject.includes(TARGET_GROUP_NAME)) {
						foundJid = jid
						break
					}
				}

				if (foundJid) {
					logger.info(`✅ تم العثور على المجموعة بالمعرف: ${foundJid}`)
					logger.info(`📤 جاري إرسال رابط تجريبي: ${TEST_LINK}`)
					
					await sock.sendMessage(foundJid, { text: TEST_LINK })
					logger.info(`✅ تم إرسال الرابط التجريبي بنجاح!`)
				} else {
					logger.warn(`⚠️ لم يتم العثور على مجموعة باسم "${TARGET_GROUP_NAME}" في الحساب. المجموعات المتوفرة هي:`)
					for (const jid in groups) {
						logger.warn(`- ${groups[jid].subject}`)
					}
				}
			} catch (err) {
				logger.error(`❌ فشل الاختبار: ${err}`)
			} finally {
				// إغلاق الاتصال بعد الإرسال
				logger.info(`🔌 جاري إغلاق الاتصال بنجاح.`)
				setTimeout(() => process.exit(0), 2000)
			}
		}
	})
}

runTest().catch(err => {
	logger.fatal(`❌ خطأ غير متوقع: ${err}`)
	process.exit(1)
})
