import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const expectedProjectRef = 'vwwudtzxjnhkaxujrxge'
const connection = {
	host: 'aws-0-ap-south-1.pooler.supabase.com',
	port: 5432,
	database: 'postgres',
	user: `postgres.${expectedProjectRef}`,
	ssl: { rejectUnauthorized: false },
}

const pgEntry = path.join(os.tmpdir(), 'codex-pg-client', 'node_modules', 'pg', 'lib', 'index.js')
const pgModule = await import(pathToFileURL(pgEntry).href)
const { Client } = pgModule.default ?? pgModule
const passwordBytes = await readHidden('Supabase staging database password: ')
const client = new Client({ ...connection, password: passwordBytes.toString('utf8'), connectionTimeoutMillis: 20_000 })
passwordBytes.fill(0)

try {
	await client.connect()
	const identity = await client.query(`
		select current_database() as database,
		       current_user as database_user,
		       current_setting('server_version') as server_version
	`)
	if (identity.rows[0].database !== 'postgres' || identity.rows[0].database_user !== 'postgres') {
		throw new Error(`Safety check failed: connected to ${identity.rows[0].database} as ${identity.rows[0].database_user}`)
	}

	const before = await client.query(`
		select schemaname, tablename
		from pg_tables
		where schemaname = 'public'
		order by tablename
	`)
	console.log(`Connected safely through ${connection.user} to staging project ${expectedProjectRef}.`)
	console.log(`Existing public tables before migration: ${before.rows.length}`)

	await applySqlFile(client, 'supabase/migrations/001_link_recovery_schema.sql', 'schema migration 001')
	await verifySchema(client)

	if (await recoveryIsComplete(client)) {
		console.log('Recovery import already complete; skipping migration 002.')
	} else {
		await applySqlFile(client, 'supabase/migrations/002_import_recovered_links.sql', 'recovery import 002')
	}
	await verifyRecovery(client)

	await applySqlFile(client, 'supabase/migrations/003_fix_claim_function_pgcrypto_path.sql', 'pgcrypto path fix 003')
	await applySqlFile(client, 'supabase/verification/verify_claim_flow.sql', 'claim-flow verification')
	await verifyRecovery(client)
	console.log('STAGING_MIGRATION_COMPLETE')
} finally {
	await client.end().catch(() => {})
}

async function applySqlFile(client, relativePath, label) {
	const sql = await fs.readFile(relativePath, 'utf8')
	console.log(`Applying ${label}...`)
	await client.query(sql)
	console.log(`Applied ${label}.`)
}

async function verifySchema(client) {
	const tables = await client.query(`
		select tablename
		from pg_tables
		where schemaname = 'public'
		  and tablename in ('system_counters', 'links', 'link_occurrences')
		order by tablename
	`)
	const functions = await client.query(`
		select proname
		from pg_proc p
		join pg_namespace n on n.oid = p.pronamespace
		where n.nspname = 'public'
		  and proname in ('claim_link_for_sending', 'mark_link_failed', 'mark_link_sent')
		order by proname
	`)
	if (tables.rowCount !== 3 || functions.rowCount !== 3) {
		throw new Error(`Schema verification failed: ${tables.rowCount} tables, ${functions.rowCount} functions`)
	}
	console.log('Schema verified: 3 tables and 3 sending functions.')
}

async function verifyRecovery(client) {
	const actual = await readRecoveryTotals(client)
	const expected = expectedRecoveryTotals()
	for (const [key, value] of Object.entries(expected)) {
		if (actual[key] !== value) throw new Error(`Recovery verification failed for ${key}: ${actual[key]} != ${value}`)
	}
	console.log(`Recovery verified: ${actual.unique_links} links, ${actual.occurrences} occurrences, counter ${actual.counter_value}.`)
}

async function recoveryIsComplete(client) {
	try {
		const actual = await readRecoveryTotals(client)
		return Object.entries(expectedRecoveryTotals()).every(([key, value]) => actual[key] === value)
	} catch {
		return false
	}
}

async function readRecoveryTotals(client) {
	const result = await client.query(`
		select
		  count(*)::int as unique_links,
		  count(*) filter (where status = 'historically_sent')::int as historically_sent,
		  count(*) filter (where status = 'observed_unconfirmed')::int as observed_unconfirmed,
		  count(*) filter (where display_serial is not null)::int as historical_live_serials,
		  (select count(*)::int from public.link_occurrences) as occurrences,
		  (select counter_value::int from public.system_counters where counter_key = 'link_display_serial') as counter_value
		from public.links
		where metadata->>'recoverySourceSha256' = '1e9c1a1aac29434ce86451055f721d92d87b92f9a088cd6f1aba26cb7d9358f0'
	`)
	return result.rows[0]
}

function expectedRecoveryTotals() {
	return {
		unique_links: 5835,
		historically_sent: 4082,
		observed_unconfirmed: 1753,
		historical_live_serials: 0,
		occurrences: 8158,
		counter_value: 1156,
	}
}

function readHidden(prompt) {
	if (!process.stdin.isTTY) throw new Error('Run this script from an interactive terminal')
	process.stdout.write(prompt)
	process.stdin.setRawMode(true)
	process.stdin.resume()
	const bytes = []
	return new Promise((resolve, reject) => {
		const onData = chunk => {
			for (const byte of chunk) {
				if (byte === 3) {
					cleanup()
					reject(new Error('Cancelled'))
					return
				}
				if (byte === 13 || byte === 10) {
					cleanup()
					process.stdout.write('\n')
					resolve(Buffer.from(bytes))
					return
				}
				if (byte === 8 || byte === 127) bytes.pop()
				else bytes.push(byte)
			}
		}
		const cleanup = () => {
			process.stdin.off('data', onData)
			process.stdin.setRawMode(false)
			process.stdin.pause()
		}
		process.stdin.on('data', onData)
	})
}
