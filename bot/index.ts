import http from 'http'
import fs from 'fs'
import path from 'path'
import { config } from './config'
import QRCode from 'qrcode'
import { startWhatsAppSession, activeSockets, sessionQRs } from './services/whatsapp'

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

	// 2. تشغيل خادم ويب تفاعلي لعرض الباركود النقي ومتابعة حالة الاتصال
	const PORT = process.env.PORT || 3000
	const server = http.createServer(async (req, res) => {
		try {
			const cards: string[] = []
			for (const session of config.SESSIONS) {
				const isConnected = activeSockets.has(session)
				const qrData = sessionQRs.get(session)
				const role = session === config.SENDER_SESSION ? 'مرسل فقط' : 'قارئ فقط'

				let contentHtml = ''
				if (isConnected) {
					contentHtml = `
						<div class="status-badge connected">
							<span class="dot"></span> متصل ونشط 24/7
						</div>
						<p class="desc">✅ الحساب مرتبط بالسيرفر بنجاح ويعمل حالياً.</p>
					`
				} else if (qrData) {
					const dataUrl = await QRCode.toDataURL(qrData, { width: 280, margin: 2 })
					contentHtml = `
						<div class="qr-box">
							<img src="${dataUrl}" alt="QR Code" />
						</div>
						<p class="desc">📱 افتح واتساب ⬅️ <b>الأجهزة المرتبطة</b> ⬅️ <b>ربط جهاز</b> ⬅️ وامسح الباركود أعلاه.</p>
					`
				} else {
					contentHtml = `
						<div class="status-badge pending">
							<span class="dot"></span> جاري تهيئة الاتصال...
						</div>
						<p class="desc">يرجى الانتظار ثوانٍ معدودة لتوليد الباركود...</p>
					`
				}

				cards.push(`
					<div class="card">
						<div class="card-header">
							<h2>${session}</h2>
							<span class="role-tag">${role}</span>
						</div>
						${contentHtml}
					</div>
				`)
			}

			const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>لوحة ربط بوت واتساب</title>
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
		body { background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; align-items: center; min-height: 100vh; padding: 30px 15px; }
		.header { text-align: center; margin-bottom: 25px; }
		.header h1 { font-size: 22px; color: #38bdf8; margin-bottom: 8px; }
		.header p { color: #94a3b8; font-size: 14px; }
		.container { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; max-width: 850px; width: 100%; }
		.card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 20px; width: 360px; max-width: 100%; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
		.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #334155; padding-bottom: 10px; }
		.card-header h2 { font-size: 17px; color: #e2e8f0; }
		.role-tag { background: #3b82f6; color: white; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; }
		.qr-box { background: white; padding: 10px; border-radius: 12px; display: inline-block; margin-bottom: 12px; }
		.qr-box img { display: block; width: 260px; height: 260px; }
		.desc { color: #cbd5e1; font-size: 13px; line-height: 1.6; }
		.status-badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 30px; font-size: 14px; font-weight: bold; margin-bottom: 15px; }
		.status-badge.connected { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid #22c55e; }
		.status-badge.pending { background: rgba(234, 179, 8, 0.15); color: #facc15; border: 1px solid #eab308; }
		.dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; }
	</style>
	<script>
		// تحديث تلقائي كل 4 ثوانٍ لمتابعة الباركود والاتصال
		setTimeout(() => location.reload(), 4000);
	</script>
</head>
<body>
	<div class="header">
		<h1>🤖 لوحة ربط بوت واتساب</h1>
		<p>امسح رمز الباركود من كاميرا واتساب (الأجهزة المرتبطة) لربط البوت فوراً</p>
	</div>
	<div class="container">
		${cards.join('')}
	</div>
</body>
</html>`

			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
			res.end(html)
		} catch (err) {
			res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
			res.end('WhatsApp Link & Student Leads Detector is Active! 🚀')
		}
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
