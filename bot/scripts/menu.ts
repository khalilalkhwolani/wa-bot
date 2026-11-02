/**
 * 🎛️ Interactive Bot Management Menu
 * Usage: npm run menu
 */

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { spawnSync } from 'child_process'
import { config, SESSIONS_DIR } from '../config'
import { SESSION_PACKS_DIR } from '../services/sessionStore'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SESSIONS_BACKUP_DIR = SESSION_PACKS_DIR

// Accounts always shown in the menu even if not yet linked
const DEFAULT_ACCOUNTS = config.SESSIONS

// ─────────────────────────────────────────────────────────────────────────────
// Screen Utilities
// ─────────────────────────────────────────────────────────────────────────────

function clearScreen() {
	// \x1Bc resets the terminal and moves cursor to top
	process.stdout.write('\x1Bc')
}

function printBanner() {
	console.log('')
	console.log('  ══════════════════════════════════════════════════════')
	console.log('         🤖  WhatsApp Bot Management System  🤖')
	console.log('  ══════════════════════════════════════════════════════')
}

function printLine() {
	console.log('  ──────────────────────────────────────────────────────')
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Logic
// ─────────────────────────────────────────────────────────────────────────────

function getExistingAccounts(): string[] {
	if (!fs.existsSync(SESSIONS_DIR)) return []
	return fs
		.readdirSync(SESSIONS_DIR)
		.filter(d => /^auth_info_account_[1-9]\d*$/.test(d) && fs.statSync(path.join(SESSIONS_DIR, d)).isDirectory())
		.map(d => d.replace('auth_info_', ''))
		.sort()
}

/**
 * Calculates the next account ID by checking both sessions/ and sessions-backup/
 * to avoid reusing an existing number.
 */
function getNextAccountId(): string {
	const sources: string[] = [...DEFAULT_ACCOUNTS, ...getExistingAccounts()]

	if (fs.existsSync(SESSIONS_BACKUP_DIR)) {
		fs.readdirSync(SESSIONS_BACKUP_DIR)
			.filter(f => f.endsWith('.json'))
			.forEach(f => sources.push(f.replace('.json', '')))
	}

	const nums = Array.from(new Set(sources))
		.map(a => { const m = a.match(/account_(\d+)/); return m ? parseInt(m[1]) : 0 })
		.filter(n => n > 0)

	const max = nums.length > 0 ? Math.max(...nums) : 0
	return `account_${max + 1}`
}

/**
 * Check session status in three stages:
 * 1. .invalidated file exists → disconnected (401)
 * 2. creds.json missing → not linked
 * 3. creds.me.id empty → linking incomplete
 */
function getSessionStatus(accountId: string): 'linked' | 'invalidated' | 'missing' {
	const folder = path.join(SESSIONS_DIR, `auth_info_${accountId}`)
	if (!fs.existsSync(folder)) return 'missing'
	if (fs.existsSync(path.join(folder, '.invalidated'))) return 'invalidated'

	const credsFile = path.join(folder, 'creds.json')
	if (!fs.existsSync(credsFile)) return 'missing'

	try {
		const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'))
		return creds?.me?.id ? 'linked' : 'missing'
	} catch {
		return 'missing'
	}
}

function statusIcon(status: 'linked' | 'invalidated' | 'missing'): string {
	if (status === 'linked') return '🟢'
	if (status === 'invalidated') return '🔴'
	return '⚪'
}

function statusLabel(status: 'linked' | 'invalidated' | 'missing'): string {
	if (status === 'linked') return 'Saved session (connection not yet verified)'
	if (status === 'invalidated') return 'Disconnected (needs re-linking)'
	return 'Not linked'
}

// ─────────────────────────────────────────────────────────────────────────────
// Process Runner — spawnSync to avoid all async SIGINT issues
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs a command synchronously (spawnSync) instead of async spawn.
 * This avoids all SIGINT issues, listener accumulation, and DEP0190 warnings.
 * The menu waits until the command finishes, then returns.
 */
function runSync(command: string, args: string[]): number | null {
	const result = spawnSync(command, args, {
		stdio: 'inherit',
		shell: false,        // no shell needed — node is directly on PATH
		env: process.env,
	})
	if (result.error) console.error('Could not start:', result.error.message)
	if (result.signal) console.error('Stopped by signal:', result.signal)
	return result.status
}

// ─────────────────────────────────────────────────────────────────────────────
// readline helper
// ─────────────────────────────────────────────────────────────────────────────
function ask(rl: readline.Interface, question: string): Promise<string> {
	return new Promise(resolve => rl.question(question, resolve))
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu Actions
// ─────────────────────────────────────────────────────────────────────────────

function startBot() {
	clearScreen()
	printBanner()
	console.log('\n  🚀 Starting the bot...')
	console.log('     Ctrl+C stops the process. If the menu closes, run npm run menu again.\n')
	printLine()

	runSync(process.execPath, ['--env-file=.env', '--import', 'tsx', './bot/index.ts'])

	console.log('\n  ⏹️  Bot stopped.')
}

function linkAccount(accountId: string, relink = false) {
	clearScreen()
	printBanner()
	console.log(`\n  🔗 Linking account: [${accountId}]\n`)
	printLine()

	const status = getSessionStatus(accountId)

	if (status === 'invalidated') {
		console.log(`  ⚠️  Account [${accountId}] was disconnected from WhatsApp.`)
		console.log('      Old session will be archived before a new QR code is generated.\n')
	} else if (status === 'linked') {
		console.log(`  ⚠️  Account [${accountId}] is currently linked.`)
		console.log('      Current session will be archived only after explicit confirmation.\n')
	}

	console.log('  📸 Scan instructions:\n')
	console.log('     1. Open WhatsApp on your phone')
	console.log('     2. Go to: Linked Devices')
	console.log('     3. Tap "Link a Device" and scan the QR code\n')
	printLine()

	const exitCode = runSync(process.execPath, [
		'--env-file=.env',
		'--import', 'tsx',
		'./bot/scripts/link-account.ts',
		accountId,
		...(relink ? ['--relink'] : []),
	])

	console.log('')
	if (exitCode === 0 && getSessionStatus(accountId) === 'linked') {
		console.log(`  ✅ [${accountId}] linked successfully!\n`)
	} else {
		console.log(`  ❌ [${accountId}] linking did not complete. You can try again.\n`)
	}
	return exitCode === 0 && getSessionStatus(accountId) === 'linked'
}

async function createAndLinkNewAccount(rl: readline.Interface) {
	clearScreen()
	printBanner()

	const newId = getNextAccountId()
	console.log(`\n  ✨ Creating new account: [${newId}]\n`)
	printLine()
	console.log(`  Will create: sessions/auth_info_${newId}\n`)

	const answer = (await ask(rl, `  Do you want to link [${newId}] now by scanning the QR code? (yes/no): `)).trim()
	const yes = ['y', 'yes', '1', 'نعم'].includes(answer.toLowerCase())

	if (yes) {
		rl.pause()
		const linked = linkAccount(newId)
		rl.resume()
		if (!linked) return
		printLine()
		console.log(`  💡 To activate [${newId}] in the bot, add it to your .env file:`)
		console.log(`     BOT_SESSIONS=${Array.from(new Set([...config.SESSIONS, newId])).join(',')}\n`)
	} else {
		console.log('\n  ⏸️  Cancelled.\n')
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Menu
// ─────────────────────────────────────────────────────────────────────────────

async function showMenu(rl: readline.Interface) {
	while (true) {
		clearScreen()
		printBanner()

		// ── Account Status ──────────────────────────────
		const existing = getExistingAccounts()
		const allAccounts = Array.from(new Set([...DEFAULT_ACCOUNTS, ...existing])).sort()

		console.log('\n  📋 Account Status:\n')
		for (const acc of allAccounts) {
			const s = getSessionStatus(acc)
			console.log(`     ${statusIcon(s)}  [${acc}]  —  ${statusLabel(s)}`)
		}

		// ── Build Link Buttons ──────────────────────────
		const linkOptions: { key: string; accountId: string }[] = []
		let keyNum = 2
		for (const acc of allAccounts) {
			linkOptions.push({ key: String(keyNum), accountId: acc })
			keyNum++
		}
		const createKey = String(keyNum)
		const nextId = getNextAccountId()

		// ── Display Menu ────────────────────────────────
		printLine()
		console.log('\n  📌 Choose an action:\n')
		console.log('     [1]  🚀 Start the bot')
		printLine()
		for (const opt of linkOptions) {
			const s = getSessionStatus(opt.accountId)
			const badge = s === 'linked' ? '🟢 Linked' : s === 'invalidated' ? '🔴 Needs re-linking' : '⚪ Not linked'
			console.log(`     [${opt.key}]  🔗 Link [${opt.accountId}]  (${badge})`)
		}
		printLine()
		console.log(`     [${createKey}]  ✨ Create new account [${nextId}] + link it`)
		console.log('     [0]  🚪 Exit')
		printLine()

		const choice = (await ask(rl, '\n  👉 Your choice: ')).trim()

		if (choice === '0') {
			clearScreen()
			console.log('\n  👋 Goodbye!\n')
			rl.close()
			process.exit(0)
		} else if (choice === '1') {
			rl.pause()
			startBot()
			rl.resume()
			await ask(rl, '\n  Press Enter to return to menu...')
		} else if (choice === createKey) {
			await createAndLinkNewAccount(rl)
			await ask(rl, '\n  Press Enter to return to menu...')
		} else {
			const found = linkOptions.find(o => o.key === choice)
			if (found) {
				const exists = fs.existsSync(path.join(SESSIONS_DIR, `auth_info_${found.accountId}`)) || fs.existsSync(path.join(SESSIONS_BACKUP_DIR, `${found.accountId}.json`))
				if (exists && (await ask(rl, 'Archive existing session and re-link? Type RELINK to confirm: ')).trim() !== 'RELINK') continue
				rl.pause()
				linkAccount(found.accountId, exists)
				rl.resume()
				await ask(rl, '\n  Press Enter to return to menu...')
			} else {
				console.log('\n  ⚠️  Invalid choice, please try again...')
				await new Promise(r => setTimeout(r, 1000))
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

rl.on('SIGINT', () => {
	clearScreen()
	console.log('\n\n  👋 Cancelled.\n')
	rl.close()
	process.exit(0)
})

showMenu(rl).catch(err => {
	console.error('\n  ❌ Menu error:', err?.message || err)
	rl.close()
	process.exit(1)
})
