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
apply further migrations. The export also exposes 26 existing local versions
that are not recorded remotely. Several are alternate timestamps for applied
migrations, while others require independent schema review. Their full list is
in `local_versions_not_in_export` in the companion JSON. No version is marked
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
- The existing 13 applied migration files and 26 local-only migrations are unchanged.
- No remote migration execution was performed: the connected Supabase account
  cannot access this project. Live dry-run and full historical replay are unverified.
