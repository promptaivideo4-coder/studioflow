# Restore the recorded Supabase migration history

The owner exported `supabase_migrations.schema_migrations` from project
`zilwgiuiygqqardzutxi` on 2026-11-16 after the Supabase Preview check on merge
`f03daee` failed with `Remote migration versions not found in local migrations directory.`

The export records 167 applied versions. Main contains 13 of those versions;
this change restores the other 154 using their recorded names and original
statement text, with whitespace-only blank lines normalized. Existing migration
files are unchanged. Statement boundaries
are separated by a semicolon when the recorded statement has no terminator.
The companion JSON records restored-file hashes and all 167 applied versions.

## Release boundary

This restores missing history; it does not prove that production is ready to
apply further migrations. The export originally exposed 26 local versions not recorded remotely. Eight
proven aliases have now been removed from the active migration directory; all
their executable statements match already-applied canonical SQL, including
quoted values and function bodies. Test/document references use the canonical
versions. Their mappings and prior hashes are in `reconciled_aliases`.

The remaining 18 versions contain genuine differences and are listed in
`local_versions_not_in_export`. Their statement-level comparison is recorded in
`migration-drift-review.json`. They must not be blindly replayed or marked applied. No version is marked
applied or reverted and no history repair, reset, or database change is made.

Before applying anything, compare the current remote migration list again,
reconcile alternate versions, and inspect the remote dry-run. Do not use
`--include-all` or `migration repair` merely to bypass the discrepancy. Do not
replay the initial reset migration against an existing database. An already
applied version will be skipped only when its history is retained.

The restored history includes shared salon, food, partner, and recruitment
schemas because the connected production database records all of them. Keep
this recovery separate from a fresh-database installation or seed workflow.

## Validation

- All 167 exported applied versions have exactly one local migration file.
- All 154 restored files preserve the exported statement text and match the
  SHA-256 hashes recorded in the companion JSON.
- The existing 13 applied files and all 154 restored applied files are unchanged.
- Eight unrecorded duplicate aliases are removed; the remaining 18 SQL files are unchanged.
- No remote migration execution was performed: the connected Supabase account
  cannot access this project. Live dry-run and full historical replay are unverified.

## Historical worker references in CI

Both initial failing CI jobs stopped in `verify-edge-functions.mjs`. Restored SQL
records four worker dependencies absent from this source tree: food notification,
food deletion, recruitment push, and the legacy StudioFlow customer engagement
worker. This inventory is not evidence that those workers are deployed or healthy.

`historical_edge_references` explicitly records their three original migration
paths and endpoint names. The Edge guard accepts a reference only in that exact
applied file, with its original SHA-256 checksum. Changed historical SQL, new
migrations, browser invocations, active server callers and unlisted names still
require real source. No function source checks, authentication checks or CI jobs
are disabled. The migration SQL itself remains unchanged.

These four worker deployments remain an independent release verification item,
alongside the remaining 18 unmatched local versions. CI passing does not establish live
notification delivery or database deployment readiness.

## Live catalog preflight

`studioflow-live-schema-preflight.sql` is a single read-only SELECT targeting
116 function names and 78 relation names referenced by the remaining migrations.
It returns one JSON result: current migration versions, relevant function
definitions/overloads, columns, constraints, RLS policies, grants, indexes,
triggers, and missing objects. It does not read customer rows or Vault secrets
and does not repair migration history or change the schema.

Run it in the project SQL editor and export the result for comparison. This
resolves whether local SQL is genuinely absent, applied outside recorded history,
or would replace a newer live contract. The connected account still cannot
read this project's catalog; production readiness remains unverified.
