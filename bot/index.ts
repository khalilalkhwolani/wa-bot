import http from 'http'
import fs from 'fs'
import path from 'path'
import { config } from './config'
import { startWhatsAppSession } from './services/whatsapp'

/**
 * استرجاع الجلسات تلقائياً من متغيرات البيئة إذا وُجدت
 */
function restoreSessionsFromEnv() {
	for (const session of ['account_1', 'account_2']) {
		const envKey = `SESSION_${session.toUpperCase()}`
		const b64 = process.env[envKey]
		if (b64) {
			const targetDir = path.join('sessions', `auth_info_${session}`)
			if (!fs.existsSync(targetDir) || fs.readdirSync(targetDir).length === 0) {
				fs.mkdirSync(targetDir, { recursive: true })
				try {
					const jsonStr = Buffer.from(b64, 'base64').toString('utf8')
					const files = JSON.parse(jsonStr)
					for (const [filename, content] of Object.entries(files)) {
						const filePath = path.join(targetDir, filename)
						fs.writeFileSync(filePath, content as string, 'utf8')
					}
					console.log(`📦 تم استرجاع جلسة [${session}] من متغيرات البيئة!`)
				} catch (err) {
					console.error(`⚠️ خطأ فك حزمة الجلسة [${session}]:`, err)
				}
			}
		}
	}
}

/**
 * نقطة الدخول الرئيسية للنظام (Main Entry Point)
 */
async function main() {
	console.log('🤖 جاري تشغيل محرك التقاط وتصنيف طلبات الطلاب والروابط الموحد...');

	// 1. إنشاء مجلد الجلسات واسترجاع الجلسات إن وُجدت
	if (!fs.existsSync('sessions')) {
		fs.mkdirSync('sessions')
	}
	restoreSessionsFromEnv()

	// 2. تشغيل خادم ويب HTTP بسيط لإرضاء شروط Render ودعم UptimeRobot Pings
	const PORT = process.env.PORT || 3000
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
		res.end('WhatsApp Link & Student Leads Detector is Active! 🚀')
	})
	
	server.listen(PORT, () => {
		console.log(`🌐 خادم ويب نشط لـ Render يعمل على المنفذ: ${PORT}`)
	})

	// 3. تشغيل كافة جلسات واتساب المحددة في الإعدادات بالتوازي
	for (const session of config.SESSIONS) {
		startWhatsAppSession(session).catch(err => {
			console.error(`❌ فشل تشغيل الجلسة [${session}]:`, err)
		})
	}
}

main().catch(err => {
	console.error('🚨 فشل تشغيل النظام الموحد بالكامل:', err)
})
