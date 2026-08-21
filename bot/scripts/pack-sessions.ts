/**
 * حزم الجلسات المحلية إلى sessions-backup/*.json (ملف واحد لكل حساب)
 * التشغيل: npx tsx bot/scripts/pack-sessions.ts
 */
import { config } from '../config'
import { packAllLocalSessions } from '../services/sessionStore'

packAllLocalSessions(config.SESSIONS)
console.log('✅ انتهى التحزيم — ارفع مجلد sessions-backup فقط مع الكود، لا ترفع sessions/')
