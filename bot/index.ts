import http from 'http'
import { config } from './config'
import { startWhatsAppSession } from './services/whatsapp'
import { restoreAllSessions } from './services/sessionStore'

// مكتبة libsignal قد تطبع كائن الجلسة كاملاً عند إغلاق سلسلة قديمة، وفيه مفاتيح
// تشفير داخلية. نحجب هذا السطر فقط ونبقي بقية رسائل console.info كما هي.
const originalConsoleInfo = console.info.bind(console)
console.info = (...args: unknown[]) => {
	if (args[0] === 'Closing session:') {
		originalConsoleInfo('🔐 أُغلقت جلسة تشفير قديمة (حُجبت تفاصيل المفاتيح من السجل)')
		return
	}
	originalConsoleInfo(...args)
}

/**
 * نقطة الدخول الرئيسية للنظام (Main Entry Point)
 */
async function main() {
	console.log('🤖 جاري تشغيل محرك التقاط وتصنيف طلبات الطلاب والروابط الموحد...');

	// 1. إنشاء مجلد الجلسات واسترجاع الحزم من Git إن لزم

	// 2. تشغيل خادم ويب HTTP بسيط لإرضاء شروط Render ودعم UptimeRobot Pings
	const PORT = process.env.PORT || 3000
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
		res.end('WhatsApp Link & Student Leads Detector is Active! 🚀')
	})

	// لا نبدأ أي جلسة واتساب إذا كان هناك بوت آخر يشغل المنفذ نفسه؛
	// تشغيل نسختين للحساب نفسه يؤدي مباشرة إلى Stream Errored (conflict) 440.
	const serverReady = await new Promise<boolean>(resolve => {
		server.once('error', error => {
			const code = (error as NodeJS.ErrnoException).code
			if (code === 'EADDRINUSE') {
				console.error(`⛔ يوجد بوت آخر يعمل بالفعل على المنفذ ${PORT}. أوقف النسخة القديمة أولاً؛ لم تُفتح أي جلسة واتساب.`)
				resolve(false)
				return
			}
			console.error(`❌ فشل فتح خادم البوت على المنفذ ${PORT}:`, error)
			resolve(false)
		})
		server.listen(PORT, () => {
			console.log(`🌐 خادم ويب نشط لـ Render يعمل على المنفذ: ${PORT}`)
			resolve(true)
		})
	})
	if (!serverReady) { process.exitCode = 1; return }
	await restoreAllSessions(config.SESSIONS)

	// 3. تشغيل الجلسات بالتتابع بفاصل كافٍ؛ لا نفتح اتصالين ثقيلين في وقت واحد.
	for (let i = 0; i < config.SESSIONS.length; i++) {
		const session = config.SESSIONS[i]
		if (i > 0) {
			await new Promise(r => setTimeout(r, 15_000))
		}
		startWhatsAppSession(session).catch(err => {
			console.error(`❌ فشل تشغيل الجلسة [${session}]:`, err)
		})
	}
}

// ───────────────────────────────────────────────────────────────
// حماية عالمية: تمنع أي استثناء أو promise مرفوض غير معالج
// من إيقاف العملية بالكامل (مثل ECONNRESET من TLS/libsignal)
// ───────────────────────────────────────────────────────────────
function networkErrorCode(error: unknown): string | undefined {
	let current: unknown = error
	for (let depth = 0; depth < 3 && current; depth++) {
		const candidate = current as NodeJS.ErrnoException & { cause?: unknown }
		if (candidate.code) return candidate.code
		current = candidate.cause
	}
	return undefined
}

function isTransientNetworkError(error: unknown): boolean {
	return ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(networkErrorCode(error) || '')
}

process.on('uncaughtException', (err: Error) => {
	const code = networkErrorCode(err)
	if (isTransientNetworkError(err)) {
		console.warn(`⚠️ [uncaughtException] خطأ شبكي تجاهلناه (${code}):`, err.message)
	} else {
		console.error('🚨 [uncaughtException] استثناء غير متوقع:', err)
	}
})

process.on('unhandledRejection', (reason: unknown) => {
	const code = networkErrorCode(reason)
	if (isTransientNetworkError(reason)) {
		console.warn(`⚠️ [unhandledRejection] خطأ شبكي تجاهلناه (${code}):`, (reason as Error).message)
	} else {
		console.error('🚨 [unhandledRejection] promise مرفوض غير معالج:', reason)
	}
})

main().catch(err => {
	console.error('🚨 فشل تشغيل النظام الموحد بالكامل:', err)
})
