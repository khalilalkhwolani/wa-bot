import http from 'http'
import fs from 'fs'
import { config } from './config'
import { startWhatsAppSession } from './services/whatsapp'
import { restoreAllSessions } from './services/sessionStore'

/**
 * نقطة الدخول الرئيسية للنظام (Main Entry Point)
 */
async function main() {
	console.log('🤖 جاري تشغيل محرك التقاط وتصنيف طلبات الطلاب والروابط الموحد...');

	// 1. إنشاء مجلد الجلسات واسترجاع الحزم من Git إن لزم
	if (!fs.existsSync('sessions')) {
		fs.mkdirSync('sessions')
	}
	await restoreAllSessions(config.SESSIONS)

	// 2. تشغيل خادم ويب HTTP بسيط لإرضاء شروط Render ودعم UptimeRobot Pings
	const PORT = process.env.PORT || 3000
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
		res.end('WhatsApp Link & Student Leads Detector is Active! 🚀')
	})

	server.listen(PORT, () => {
		console.log(`🌐 خادم ويب نشط لـ Render يعمل على المنفذ: ${PORT}`)
	})

	// 3. تشغيل الجلسات بالتتابع بفاصل بسيط (يقلل طرد واتساب عند فتح حسابين معًا)
	for (let i = 0; i < config.SESSIONS.length; i++) {
		const session = config.SESSIONS[i]
		if (i > 0) {
			await new Promise(r => setTimeout(r, 4000))
		}
		startWhatsAppSession(session).catch(err => {
			console.error(`❌ فشل تشغيل الجلسة [${session}]:`, err)
		})
	}
}

main().catch(err => {
	console.error('🚨 فشل تشغيل النظام الموحد بالكامل:', err)
})
