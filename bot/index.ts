import http from 'http'
import fs from 'fs'
import path from 'path'
import { config, getRoleLabel, SESSIONS_DIR } from './config'
import QRCode from 'qrcode'
import { startWhatsAppSession, activeSockets, sessionQRs, liveEvents } from './services/whatsapp'
import { restoreAllSessions } from './services/sessionStore'

/**
 * نقطة الدخول الرئيسية للنظام (Main Entry Point)
 */
async function main() {
	console.log('🤖 جاري تشغيل محرك التقاط وتصنيف طلبات الطلاب والروابط الموحد...');
	console.log(`📁 مجلد الجلسات المحلي: ${path.resolve(SESSIONS_DIR)}`)

	// 1. استرجاع الجلسات من حزم Git (sessions-backup) ثم اختياريًا Upstash/Env
	if (!fs.existsSync(SESSIONS_DIR)) {
		fs.mkdirSync(SESSIONS_DIR, { recursive: true })
	}
	await restoreAllSessions(config.SESSIONS)

	// 2. تشغيل خادم ويب تفاعلي لعرض الباركود ومتابعة حالة الاتصال وسجل الأحداث الحي
	const PORT = process.env.PORT || 3000
	const server = http.createServer(async (req, res) => {
		try {
			// مسار API لجلب الحالة الحية وسجل الأحداث
			if (req.url === '/api/status') {
				const statusList = []
				for (const account of config.ACCOUNTS) {
					const session = account.id
					const sock = activeSockets.get(session)
					const isConnected = !!sock
					const qrData = sessionQRs.get(session)
					const role = getRoleLabel(session)
					const phone = sock?.user?.id ? sock.user.id.split(':')[0] : ''

					let qrImage = ''
					if (!isConnected && qrData) {
						qrImage = await QRCode.toDataURL(qrData, { width: 280, margin: 2 })
					}

					statusList.push({
						session,
						role,
						isConnected,
						phone,
						hasQR: !isConnected && !!qrData,
						qrImage
					})
				}
				res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
				res.end(JSON.stringify({ sessions: statusList, events: liveEvents }))
				return
			}

			// مسار الصفحة الرئيسية
			const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>لوحة مراقبة وإدارة بوت واتساب</title>
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
		body { background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; align-items: center; min-height: 100vh; padding: 30px 15px; }
		.header { text-align: center; margin-bottom: 25px; }
		.header h1 { font-size: 22px; color: #38bdf8; margin-bottom: 8px; }
		.header p { color: #94a3b8; font-size: 14px; }
		.main-layout { display: flex; flex-direction: column; gap: 25px; width: 100%; max-width: 950px; align-items: center; }
		.container { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; width: 100%; }
		.card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 22px; width: 360px; max-width: 100%; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.3); transition: all 0.3s ease; }
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
		.phone-info { margin-top: 8px; color: #38bdf8; font-size: 14px; font-weight: bold; }
		
		/* صندوق سجل الأحداث */
		.events-panel { width: 100%; background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
		.events-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #334155; padding-bottom: 10px; }
		.events-panel-header h3 { font-size: 16px; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
		.events-list { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; font-family: monospace; font-size: 13px; }
		.event-item { padding: 8px 12px; border-radius: 8px; background: #0f172a; border-right: 4px solid #64748b; display: flex; gap: 10px; align-items: center; word-break: break-all; }
		.event-item.success { border-right-color: #22c55e; color: #86efac; }
		.event-item.link { border-right-color: #38bdf8; color: #7dd3fc; }
		.event-item.warn { border-right-color: #eab308; color: #fde047; }
		.event-item.info { border-right-color: #94a3b8; color: #cbd5e1; }
		.event-time { color: #64748b; font-size: 11px; flex-shrink: 0; }
	</style>
</head>
<body>
	<div class="header">
		<h1>🤖 لوحة مراقبة وإدارة بوت واتساب</h1>
		<p>بث مباشر لحالة الاتصال وسجل الأحداث والروابط الحية</p>
	</div>

	<div class="main-layout">
		<div class="container" id="cards-container">
			<p style="color:#94a3b8;">جاري تحميل حالة البوت...</p>
		</div>

		<div class="events-panel">
			<div class="events-panel-header">
				<h3>📡 سجل النشاط والروابط الحية (Live Feed)</h3>
				<span style="font-size: 12px; color: #4ade80;">● متصل مباشرة</span>
			</div>
			<div class="events-list" id="events-container">
				<p style="color:#64748b; padding:10px;">في انتظار أحداث جديدة...</p>
			</div>
		</div>
	</div>

	<script>
		async function updateStatus() {
			try {
				const res = await fetch('/api/status');
				const data = await res.json();
				const cardsContainer = document.getElementById('cards-container');
				const eventsContainer = document.getElementById('events-container');
				
				// 1. تحديث بطاقات الحسابات
				let cardsHtml = '';
				for (const item of (data.sessions || [])) {
					let contentHtml = '';
					if (item.isConnected) {
						contentHtml = \`
							<div class="status-badge connected">
								<span class="dot"></span> متصل ونشط 24/7
							</div>
							<p class="desc">✅ الحساب مرتبط بالسيرفر ويعمل بنجاح.</p>
							\${item.phone ? \`<div class="phone-info">📱 الرقم: +\${item.phone}</div>\` : ''}
						\`;
					} else if (item.hasQR && item.qrImage) {
						contentHtml = \`
							<div class="qr-box">
								<img src="\${item.qrImage}" alt="QR Code" />
							</div>
							<p class="desc">📱 افتح واتساب ⬅️ <b>الأجهزة المرتبطة</b> ⬅️ <b>ربط جهاز</b> ⬅️ وامسح الباركود أعلاه.</p>
						\`;
					} else {
						contentHtml = \`
							<div class="status-badge pending">
								<span class="dot"></span> جاري تهيئة الاتصال...
							</div>
							<p class="desc">يرجى الانتظار ثوانٍ معدودة...</p>
						\`;
					}

					cardsHtml += \`
						<div class="card">
							<div class="card-header">
								<h2>\${item.session}</h2>
								<span class="role-tag">\${item.role}</span>
							</div>
							\${contentHtml}
						</div>
					\`;
				}
				cardsContainer.innerHTML = cardsHtml;

				// 2. تحديث سجل الأحداث الحية
				if (data.events && data.events.length > 0) {
					let eventsHtml = '';
					for (const ev of data.events) {
						eventsHtml += \`
							<div class="event-item \${ev.type}">
								<span class="event-time">\${ev.time}</span>
								<span>\${ev.message}</span>
							</div>
						\`;
					}
					eventsContainer.innerHTML = eventsHtml;
				}
			} catch (e) {
				console.error('Error fetching status', e);
			}
		}

		// تحديث هادئ واقتصادي للموارد
		updateStatus();
		setInterval(updateStatus, 5000);
	</script>
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

	// 3. تشغيل كافة جلسات واتساب من سجل الحسابات
	for (const account of config.ACCOUNTS) {
		startWhatsAppSession(account.id).catch(err => {
			console.error(`❌ فشل تشغيل الجلسة [${account.id}]:`, err)
		})
	}
}

main().catch(err => {
	console.error('🚨 فشل تشغيل النظام الموحد بالكامل:', err)
})
