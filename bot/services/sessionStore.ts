import fs from 'fs'
import path from 'path'
import { getAuthFolder } from '../config'

type SessionFiles = Record<string, string>

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

function redisConfigured(): boolean {
	return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

function redisKey(sessionId: string): string {
	return `wa_session_${sessionId}`
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
		if (!fs.statSync(full).isFile()) continue
		files[name] = fs.readFileSync(full, 'utf8')
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
		// أمان بسيط: لا مسارات فرعية
		if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) continue
		fs.writeFileSync(path.join(dir, filename), content, 'utf8')
	}
}

function folderIsEmpty(sessionId: string): boolean {
	const dir = getAuthFolder(sessionId)
	return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0
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

/**
 * حفظ جلسة في Upstash (مجاني) — يتجاوز حدود Environment على Render
 */
export async function persistSessionRemote(sessionId: string): Promise<boolean> {
	if (!redisConfigured()) return false

	const files = packSessionFolder(sessionId)
	if (!files) return false

	const payload = Buffer.from(JSON.stringify(files), 'utf8').toString('base64')
	await redisCommand(['SET', redisKey(sessionId), payload])
	console.log(`☁️ تم حفظ جلسة [${sessionId}] في التخزين السحابي المجاني (Upstash)`)
	return true
}

/**
 * استرجاع جلسة من Upstash إن وُجدت
 */
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

/**
 * استرجاع من متغير بيئة SESSION_ACCOUNT_X (احتياطي للحزم الصغيرة)
 */
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
 * استرجاع كل الحسابات: Upstash أولاً ثم Environment
 */
export async function restoreAllSessions(sessionIds: string[]): Promise<void> {
	if (redisConfigured()) {
		console.log('☁️ تخزين الجلسات السحابي (Upstash) مفعّل — لا حاجة لـ Persistent Disk')
	} else {
		console.log(
			'ℹ️ لم يُضبط Upstash بعد. على Render المجاني الجلسات تُفقد عند كل Deploy ما لم تضبط UPSTASH_REDIS_REST_URL و UPSTASH_REDIS_REST_TOKEN (مجاني).'
		)
	}

	for (const sessionId of sessionIds) {
		try {
			const fromCloud = await restoreSessionFromRemote(sessionId)
			if (!fromCloud) restoreSessionFromEnv(sessionId)
		} catch (err) {
			console.error(`⚠️ فشل استرجاع [${sessionId}]:`, err)
			restoreSessionFromEnv(sessionId)
		}
	}
}

/**
 * حفظ مؤجّل بعد تحديث المفاتيح (يمنع ضغط Upstash عند توالي التحديثات)
 */
export function scheduleSessionPersist(sessionId: string): void {
	if (!redisConfigured()) return

	const prev = saveTimers.get(sessionId)
	if (prev) clearTimeout(prev)

	saveTimers.set(
		sessionId,
		setTimeout(() => {
			persistSessionRemote(sessionId).catch(err => {
				console.error(`⚠️ فشل حفظ جلسة [${sessionId}] سحابيًا:`, err)
			})
		}, 2500)
	)
}
