# Supabase migration workflow

This directory contains reviewable, non-destructive migrations for the replacement bot.

## Safety rules

- Apply migrations to the staging project first.
- Never paste a service-role key into a tracked file.
- Do not run production imports until the recovery totals are reconciled.
- Import historical records with `display_serial = null`; preserve their old numbers in `legacy_first_serial` and `legacy_last_serial`.
- Set `system_counters.link_display_serial` to the approved current production number only after the historical import is verified.
- Keep `observed_unconfirmed` links separate from `historically_sent` links.

## Expected recovery totals before review

- All unique official links observed: 5,835
- Confirmed historically sent links: 4,082
- Observed but not confirmed as sent: 1,753
- Highest legacy display number observed: 1,156

These are extraction totals, not yet approved production totals. The source export and audit workbook remain the evidence of record.

## Generated recovery import

Run `node scripts/build-supabase-recovery-import.mjs` to regenerate
`migrations/002_import_recovered_links.sql` from the immutable recovery outputs.

The import is idempotent and wrapped in a transaction. It preserves all 8,158
occurrences, keeps historical display numbers in the legacy columns, leaves
`display_serial` empty for historical rows, and raises an exception before
commit if the expected totals do not match. Apply migrations 001 and 002 to the
staging project only, then run `verification/verify_recovered_links.sql`.

Finally run `verification/verify_claim_flow.sql`. It verifies that the first
new link receives 1157, a duplicate seen by another read-only account is not
sent again, and a failed send retries with the same number. The script ends in
`rollback`, so it leaves no test rows or counter changes.

Migration 003 adds Supabase's `extensions` schema to the claim function search
path so the pre-installed `pgcrypto.digest` function resolves correctly.
