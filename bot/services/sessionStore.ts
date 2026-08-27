import fs from 'fs'
import path from 'path'
import { getAuthFolder, SESSIONS_DIR } from '../config'

type SessionFiles = Record<string, string>

/** ملفات الحزم المرفوعة مع Git (ملف واحد لكل حساب بدل آلاف الملفات) */
export const SESSION_PACKS_DIR = process.env.SESSION_PACKS_DIR || 'sessions-backup'

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

function redisConfigured(): boolean {
	return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

function redisKey(sessionId: string): string {
	return `wa_session_${sessionId}`
}

function packPath(sessionId: string): string {
	return path.join(SESSION_PACKS_DIR, `${sessionId}.json`)
}

/**
 * حزم مجلد الجلسة إلى كائن واحد (اسم ملف → محتوى)
 */
export function packSessionFolder(sessionId: string): SessionFiles | null {
	const dir = getAuthFolder(sessionId)
	if (!fs.existsSync(dir)) return null

	const files: SessionFiles = {}
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name)
		try {
			if (!fs.statSync(full).isFile()) continue
			files[name] = fs.readFileSync(full, 'utf8')
		} catch {
			// ملف اختفى أثناء التحزيم (تدوير مفاتيح واتساب) — نتخطاه
			continue
		}
	}
	return Object.keys(files).length ? files : null
}

/**
 * فك الحزمة إلى مجلد الجلسة على القرص المحلي
 */
export function unpackSessionFolder(sessionId: string, files: SessionFiles): void {
	const dir = getAuthFolder(sessionId)
	fs.mkdirSync(dir, { recursive: true })
	for (const [filename, content] of Object.entries(files)) {
		if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) continue
		fs.writeFileSync(path.join(dir, filename), content, 'utf8')
	}
}

function folderIsEmpty(sessionId: string): boolean {
	const dir = getAuthFolder(sessionId)
	return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0
}

/**
 * حفظ حزمة الجلسة كملف واحد صالح للرفع مع Git (Private)
 */
export function persistSessionPack(sessionId: string): boolean {
	const files = packSessionFolder(sessionId)
	if (!files) return false

	fs.mkdirSync(SESSION_PACKS_DIR, { recursive: true })
	const target = packPath(sessionId)
	fs.writeFileSync(target, JSON.stringify(files), 'utf8')
	const sizeKb = Math.round(Buffer.byteLength(JSON.stringify(files), 'utf8') / 1024)
	console.log(`📦 حُفظت حزمة الجلسة [${sessionId}] → ${target} (~${sizeKb}KB)`)
	return true
}

/**
 * استرجاع من ملف الحزمة المحلي (sessions-backup)
 */
export function restoreSessionFromPack(sessionId: string): boolean {
	if (!folderIsEmpty(sessionId)) return false

	const target = packPath(sessionId)
	if (!fs.existsSync(target)) return false

	try {
		const files = JSON.parse(fs.readFileSync(target, 'utf8')) as SessionFiles
		unpackSessionFolder(sessionId, files)
		console.log(`📦 تم استرجاع جلسة [${sessionId}] من ${target}`)
		return true
	} catch (err) {
		console.error(`⚠️ فشل فك حزمة [${sessionId}]:`, err)
		return false
	}
}

async function redisCommand(command: unknown[]): Promise<unknown> {
	const url = process.env.UPSTASH_REDIS_REST_URL!
	const token = process.env.UPSTASH_REDIS_REST_TOKEN!
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(command),
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Upstash HTTP ${res.status}: ${text}`)
	}
	const data = (await res.json()) as { result?: unknown }
	return data.result
}

export async function persistSessionRemote(sessionId: string): Promise<boolean> {
	// دائمًا: حزمة محلية للـ Git
	persistSessionPack(sessionId)

	if (!redisConfigured()) return true

	const files = packSessionFolder(sessionId)
	if (!files) return false

	const payload = Buffer.from(JSON.stringify(files), 'utf8').toString('base64')
	await redisCommand(['SET', redisKey(sessionId), payload])
	console.log(`☁️ تم حفظ جلسة [${sessionId}] أيضًا في Upstash`)
	return true
}

export async function restoreSessionFromRemote(sessionId: string): Promise<boolean> {
	if (!redisConfigured()) return false
	if (!folderIsEmpty(sessionId)) return false

	const value = await redisCommand(['GET', redisKey(sessionId)])
	if (!value || typeof value !== 'string') return false

	const jsonStr = Buffer.from(value, 'base64').toString('utf8')
	const files = JSON.parse(jsonStr) as SessionFiles
	unpackSessionFolder(sessionId, files)
	console.log(`☁️ تم استرجاع جلسة [${sessionId}] من Upstash`)
	return true
}

export function restoreSessionFromEnv(sessionId: string): boolean {
	if (!folderIsEmpty(sessionId)) return false

	const envKey = `SESSION_${sessionId.toUpperCase()}`
	const b64 = process.env[envKey]
	if (!b64) return false

	try {
		const jsonStr = Buffer.from(b64, 'base64').toString('utf8')
		const files = JSON.parse(jsonStr) as SessionFiles
		unpackSessionFolder(sessionId, files)
		console.log(`📦 تم استرجاع جلسة [${sessionId}] من متغيرات البيئة`)
		return true
	} catch (err) {
		console.error(`⚠️ فشل فك جلسة البيئة [${sessionId}]:`, err)
		return false
	}
}

/**
 * ترتيب الاسترجاع: مجلد محلي → حزمة Git → Upstash → Environment
 */
export async function restoreAllSessions(sessionIds: string[]): Promise<void> {
	if (!fs.existsSync(SESSIONS_DIR)) {
		fs.mkdirSync(SESSIONS_DIR, { recursive: true })
	}

	console.log(`📦 حزم الجلسات للـ Git: ${path.resolve(SESSION_PACKS_DIR)} (ملف واحد لكل حساب)`)

	for (const sessionId of sessionIds) {
		try {
			if (!folderIsEmpty(sessionId)) {
				console.log(`✅ [${sessionId}] جلسة محلية موجودة — لا حاجة للاسترجاع`)
				continue
			}
			if (restoreSessionFromPack(sessionId)) continue
			const fromCloud = await restoreSessionFromRemote(sessionId)
			if (!fromCloud) restoreSessionFromEnv(sessionId)
		} catch (err) {
			console.error(`⚠️ فشل استرجاع [${sessionId}]:`, err)
			restoreSessionFromEnv(sessionId)
		}
	}
}

/**
 * حفظ مؤجّل بعد تحديث المفاتيح
 */
export function scheduleSessionPersist(sessionId: string): void {
	const prev = saveTimers.get(sessionId)
	if (prev) clearTimeout(prev)

	saveTimers.set(
		sessionId,
		setTimeout(() => {
			persistSessionRemote(sessionId).catch(err => {
				console.error(`⚠️ فشل حفظ جلسة [${sessionId}]:`, err)
			})
		}, 2500)
	)
}

/**
 * حزم كل الحسابات الموجودة محليًا الآن (للرفع مع Git)
 */
export function packAllLocalSessions(sessionIds: string[]): void {
	for (const id of sessionIds) {
		if (!folderIsEmpty(id)) persistSessionPack(id)
		else console.log(`⏭️ تخطي [${id}] — لا توجد جلسة محلية`)
	}
}
