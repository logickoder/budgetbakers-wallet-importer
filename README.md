# BudgetBakers CSV Importer

A command-line tool that writes transactions directly into your BudgetBakers / Wallet database — bypassing the official
import pipeline to preserve full timestamps and support multiple accounts in a single file.

---

## Why this exists

The official Wallet app import has two hard limitations:

| Limitation                       | Impact                                                               |
| -------------------------------- | -------------------------------------------------------------------- |
| Date format is `yyyy-MM-dd` only | Time of day is always stripped — every transaction lands at midnight |
| One account per import file      | Multi-account bank statements require splitting and multiple imports |

This tool writes directly to the CouchDB database that powers the app, so timestamps are preserved to the second and
every row can target a different account.

---

## Requirements

- Node.js 18+
- A BudgetBakers / Wallet account

---

## Setup

```bash
git clone https://github.com/logickoder/budgetbakers-wallet-importer.git
cd budgetbakers-wallet-importer
pnpm install   # or: npm install
```

If published on npm, install globally:

```bash
npm install -g budgetbakers-wallet-importer
```

> The repo ships with a `pnpm-lock.yaml`. `pnpm` is the canonical package
> manager — `npm` works too, but expect lockfile noise if you mix them.

---

## Usage

```bash
npm start
```

If installed globally from npm:

```bash
budgetbakers-wallet-importer
```

### CLI flag reference

| Flag                       | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `--email <email>`          | Use this email — skips email selection prompt                            |
| `--csv <path>`             | Use this CSV path — skips the path prompt                                |
| `--yes`, `-y`              | Auto-confirm the write prompt (and rollback prompts)                     |
| `--dry-run`, `--validate`  | Parse + preview + exit. No CouchDB write.                                |
| `--batch-id <uuid>`        | Reuse an existing import batch id (makes re-runs idempotent)             |
| `--rollback-import <uuid>` | Delete every record tagged with that import batch id                     |
| `--list-last <count>`      | List the N most recently created Record docs and exit                    |
| `--rollback-last <count>`  | Delete the N most recently created Record docs (after confirmation)      |
| `--start-ts <iso>`         | Lower bound when filtering `--list-last` / `--rollback-last` by created  |
| `--end-ts <iso>`           | Upper bound for the same                                                 |
| `--refresh-cache`          | Force a fresh lookup fetch from CouchDB instead of using the cache       |
| `--debug` / `--no-debug`   | Toggle verbose console logs (debug on by default; file log always on)    |
| `--log-level <level>`      | Minimum log level written to the run log file (`info`/`warn`/`error`)    |
| `-h`, `--help`             | Print help and exit                                                      |

Debug logging is enabled by default to help diagnose failures. You can disable it from run params:

```bash
npm start -- --no-debug
```

You can also pass `--debug` explicitly.

Set minimum log level with `--log-level` (`info`, `warn`, or `error`):

```bash
npm start -- --log-level warn
```

Logging is always written to a run log file under each user folder:

`./data/<user-hash>/logs/importer-<timestamp>.log`

`--debug` controls console verbosity only. File logging stays enabled in both modes.
Logs are automatically pruned to keep the latest 40 per user.

Use `--refresh-cache` to force a fresh lookup fetch from CouchDB:

```bash
npm start -- --refresh-cache
```

For automation / non-interactive runs:

```bash
npm start -- --email you@example.com --csv ./transactions.csv --yes
```

- `--email` skips email selection prompts
- `--csv` skips CSV path prompt
- `--yes` skips final write confirmation prompt

Dry-run / validation mode parses the CSV, resolves accounts and categories
against your CouchDB lookups, prints the preview, and exits without writing:

```bash
npm start -- --csv ./transactions.csv --dry-run
# alias:
npm start -- --csv ./transactions.csv --validate
```

### Import batches and duplicate prevention

Every run generates a fresh **import batch id** (a UUID). It is:

- Printed to the terminal after the preview block
- Tagged on every written record via the `importBatchId` field
- Used to derive each record's CouchDB `_id` via UUIDv5

This gives you two things for free:

1. **Re-running the same CSV under the same batch id is safe.** Identical rows
   produce identical `_id`s, so CouchDB rejects them with a 409 `conflict` and
   the importer reports them as duplicates instead of writing them again.
2. **Targeted rollback.** You can delete every record from a specific run with
   `--rollback-import <batch-id>` — no time-window guessing.

Reuse a batch id when you need to resume a partial import:

```bash
npm start -- --csv ./transactions.csv --batch-id <uuid-from-previous-run>
```

A different invocation without `--batch-id` gets a new id, so an intentional
re-import of the same CSV is still possible.

Rollback helpers:

```bash
# Preview the last 20 published Record docs
npm start -- --list-last 20

# Preview the last 20 records within a timestamp window
npm start -- --list-last 20 --start-ts "2026-03-23T08:00:00Z" --end-ts "2026-03-23T09:00:00Z"

# Delete (rollback) the last 20 published Record docs
npm start -- --rollback-last 20

# Delete (rollback) the last 20 records in a timestamp window
npm start -- --rollback-last 20 --start-ts "2026-03-23T08:00:00Z" --end-ts "2026-03-23T09:00:00Z"

# Delete (rollback) every record tagged with a specific import batch id
npm start -- --rollback-import 617b1204-9ef6-4bfa-8b04-03d0d509d7db
```

- `--list-last <count>` lists recent records and exits
- `--rollback-last <count>` lists then deletes those records after confirmation
- `--rollback-import <id>` deletes every record tagged with that import batch id
- `--start-ts <timestamp>` optional lower bound for filtering by `created` time
- `--end-ts <timestamp>` optional upper bound for filtering by `created` time
- timestamp filters are applied after fetching the requested last `<count>` records
- Add `--yes` to skip the interactive confirmation prompt in rollback mode

If the app behaves unexpectedly after an import, use --rollback-last to revert the most recent records, check what failed (for example an invalid date format), then rerun after fixing the source CSV.

Small batches are optional, but they can make errors easier to catch early when troubleshooting.

When debug is enabled, the importer writes CouchDB lookup dumps under the selected user's data folder:

`./data/<user-hash>/debug/couch-lookups-<timestamp>/`

- `metadata.json`
- `accounts.json`
- `categories.json`
- `currencies.json`
- `maps.json`

The tool will ask for:

1. **Email selection** — choose a saved email or type a new one
2. **The SSO token** — only needed when no valid saved session exists
3. **Path to your CSV file**
4. **Confirmation** — shows a summary before writing anything

Sessions are indexed in `.budgetbakers-session.json` (email -> session details) and stored per user in
`data/<user-hash>/session.json`.
Lookup data (`accounts.json`, `categories.json`, `currencies.json`, `maps.json`, `metadata.json`) is cached per user
in that same `data/<user-hash>/` directory and reused by default.

Cache files are not treated as dumps. The remaining "dump" output is debug snapshots under
`data/<user-hash>/debug/couch-lookups-<timestamp>/`, created only when debug mode is enabled.
Debug snapshots are automatically pruned to keep the latest 20 per user.

---

## CSV format

Create a plain CSV file with these six columns:

```
date,account,amount,category,note,payee
```

### Example

```csv
date,account,amount,category,note,payee
2026-01-27 02:31:00,First Bank,-53.75,Charges & Fees,Stamp Duty,
2026-01-27 02:31:00,First Bank,-78.00,Charges & Fees,Stamp Duty,
2026-01-29 13:33:00,First Bank,-300000,Transfer,,
2026-01-29 13:33:00,Palmpay,300000,Transfer,,
2026-02-10 11:25:00,First Bank,300000,Wage & invoices,,Company XYZ
2026-02-08 16:52:00,First Bank,-8520,Restaurant & fast-food,,Chowdeck
```

### Column reference

| Column     | Required | Format                | Notes                                                |
| ---------- | -------- | --------------------- | ---------------------------------------------------- |
| `date`     | yes      | `YYYY-MM-DD HH:MM:SS` | Interpreted as local time (preserves entered hour)   |
| `account`  | yes      | text                  | Must match the account name in the app exactly       |
| `amount`   | yes      | signed number         | Negative = expense, positive = income                |
| `category` | yes      | text                  | Must match the category name in the app exactly      |
| `note`     | no       | text                  | Optional description                                 |
| `payee`    | no       | text                  | Stored as a separate field, not embedded in the note |

Date normalization:

- Importer writes `recordDate` in canonical format: `YYYY-MM-DDTHH:mm:ss.SSS±HH:mm`
- Input date values are interpreted as local wall-clock time and normalized before upload
- Supported input examples include `YYYY-MM-DD HH:MM:SS`, `YYYY-MM-DDTHH:MM:SS`, and `M/D/YYTHH:mm(.SSS)(±HH:mm)`

### What you don't need to fill in

| Field            | How it's determined                                      |
| ---------------- | -------------------------------------------------------- |
| Currency         | Taken from the account's own currency — no column needed |
| Income / expense | Sign of `amount`                                         |
| Transfer flag    | Detected automatically — see Transfers below             |
| Payment type     | Electronic for transfers, cash for everything else       |

### Transfers

Write two rows with the same `date` and category `Transfer` (or whatever you named the transfer category in the app).
The importer links them automatically.

```csv
2026-01-29 13:33:00,First Bank,-300000,Transfer,,
2026-01-29 13:33:00,Palmpay,300000,Transfer,,
```

Both the category name and the timestamp must match for the pair to be linked. If a transfer row has no matching second
leg, it is moved to the failure file with an explanation.

---

## Output files

After each run, two files are written alongside your input CSV:

| File                 | Contents                                            |
| -------------------- | --------------------------------------------------- |
| `<name>_success.csv` | Rows that were written to BudgetBakers successfully |
| `<name>_failure.csv` | Rows that failed, with an extra `reason` column     |

The failure file is already in the correct CSV format — fix the issues, rename it, and re-run it as the input.

**Duplicate rows** (CouchDB 409 `conflict` because the same `_id` already
exists in this batch) are reported in the console as `↻ N duplicate(s)
skipped` and counted in the run log, but they are **not** written to either
output CSV — they are neither new successes nor failures. Re-import them by
running under a fresh batch id (drop `--batch-id`).

### Example terminal output

```
── BudgetBakers CSV Importer ──

Found saved session — skipping SSO.

Logged in as you@example.com

Fetching accounts, categories and currencies from CouchDB...
  18 accounts  ·  62 categories  ·  2 currencies

Expected CSV format:
  date,account,amount,category,note,payee
  ...

Path to CSV file: ~/transactions.csv

Parsing CSV...

  Total rows:         55
  Ready to import:    53
  Skipped (bad data): 2

  Skipped reasons:
    [2×] Unknown category: "Food" — check app for exact name

Preview:
  Per-account totals:
    First Bank · 47 rows · net -125300.50
    Palmpay    · 6 rows  · net  300000.00
  First 5 of 53 record(s):
    2026-01-27T02:31:00.000+01:00 | First Bank | -53.75 | Charges & Fees | Stamp Duty
    ...

Import batch id: 617b1204-9ef6-4bfa-8b04-03d0d509d7db

Write 53 records to BudgetBakers? [y/N] y

Writing records...

✓ 53 records written successfully
✗ 2 rows failed
  (2 bad data, 0 CouchDB rejections)

Success CSV → ~/transactions_success.csv
Failure CSV → ~/transactions_failure.csv
Rollback this batch: --rollback-import 617b1204-9ef6-4bfa-8b04-03d0d509d7db
```

Re-running the same CSV under the same batch id (idempotent retry):

```
npm start -- --csv ./transactions.csv \
             --batch-id 617b1204-9ef6-4bfa-8b04-03d0d509d7db --yes

...
Import batch id: 617b1204-9ef6-4bfa-8b04-03d0d509d7db
  (reusing supplied batch id — duplicate rows will be skipped)

Writing records...

✓ 0 records written successfully
↻ 53 duplicate(s) skipped (already in batch 617b1204-9ef6-4bfa-8b04-03d0d509d7db)
```

---

## Common errors

**`Unknown account: "First Bank"`**
The account name in your CSV does not match the app exactly. Open the app, check the account name, and update your CSV.

**`Unknown category: "Food" — check app for exact name`**
Same as above for categories. Category names are case-sensitive and must match character for character, except
transfer aliases like `TRANSFER` and `Transfer` which are mapped to the app's transfer category.

**`Transfer row has no matching pair`**
A row with the transfer category has no corresponding second row with the same timestamp. Check that both legs have the
exact same `date` string.

**`Session expired — starting fresh SSO flow`**
Your saved session token has expired. The tool handles this automatically — it clears the old token and triggers a new
SSO email.

**`↻ N duplicate(s) skipped (already in batch …)`**
Not an error. Records with the same row identity have already been written
under this batch id, so CouchDB rejected the duplicates. If you actually
meant to write the rows again, drop `--batch-id` and re-run — a fresh batch
id will produce fresh `_id`s.

---

## Project structure

```
budgetbakers-wallet-importer/
├── src/
│   ├── cli/
│   │   ├── index.ts       Main orchestration flow
│   │   ├── interaction.ts Prompting and saved-email selection UX
│   │   ├── maintenance.ts List/rollback flows (last-N + by import batch)
│   │   ├── options/
│   │   │   ├── index.ts   CLI options entry + help/exit behavior
│   │   │   ├── core.ts    Pure argument parsing and validation
│   │   │   └── types.ts   Shared RunOptions interfaces
│   │   ├── preview.ts     Per-account preview builder + printer
│   │   └── run.ts         Run id, output paths, cache/couch lookup resolver
│   ├── auth.ts            Next-Auth SSO login flow
│   ├── couch.ts           CouchDB client and runtime lookup maps
│   ├── csv.ts             CSV parser, converter, and serialiser
│   ├── date-time.ts       Local date parsing + ISO normalization
│   ├── logger.ts          File/console logger with redaction and levels
│   ├── records.ts         _bulk_docs writer + UUIDv5 _id + batch views
│   ├── utils.ts           Small shared helpers
│   ├── security/
│   │   └── tokens.ts      Token extraction/validation helpers
│   ├── storage/
│   │   ├── index.ts       Storage barrel exports
│   │   ├── paths.ts       User-path and key resolution
│   │   ├── session.ts     Session index and user session persistence
│   │   ├── cache.ts       Lookup cache read/write
│   │   └── dumps.ts       Debug dump writing and retention pruning
│   ├── tests/
│   │   ├── cli/
│   │   │   ├── maintenance.test.ts
│   │   │   ├── preview.test.ts
│   │   │   ├── run.test.ts
│   │   │   └── options/
│   │   │       └── core.test.ts
│   │   ├── csv.test.ts
│   │   ├── date-time.test.ts
│   │   └── records.test.ts
│   └── types.ts           Shared TypeScript interfaces
├── api.md                 Full API reference (endpoints, field values, curl)
├── development.md         Coding conventions and "no guessing" rule
├── package.json
├── pnpm-lock.yaml
└── tsconfig.json
```

### Architecture overview

- `cli/index.ts` coordinates flow only.
- `cli/options/*` owns all CLI argument parsing and validation.
- `cli/interaction.ts` handles all interactive questions.
- `cli/maintenance.ts` handles list/rollback flows (last-N window and by import batch id).
- `cli/preview.ts` builds and prints the pre-write preview — pure formatting, no IO outside the injectable writer.
- `cli/run.ts` contains run id, output-path derivation, and the testable cache-resolution logic.
- `records.ts` owns CouchDB record IO, deterministic UUIDv5 `_id` derivation, and the design-doc views (`records_by_reserved_created_at_v1`, `records_by_import_batch_v1`).
- `storage/*` owns persistence concerns (session index, per-user cache, dump and log file housekeeping).
- `security/tokens.ts` isolates token extraction/validation utilities.
- `auth.ts`, `couch.ts`, `csv.ts`, and `date-time.ts` stay focused on external integrations and data conversion.
- `src/tests/*` mirrors source-module paths for maintainable test discovery.

---

## How it works

BudgetBakers stores all data in a personal CouchDB database:

```
https://couch-prod-eu-2.budgetbakers.com/bb-{userId}/
```

The mobile and web apps use PouchDB to sync changes to this database. This tool authenticates with the same credentials
the app uses and writes `Record` documents directly via `_bulk_docs` — the same way the app itself does, just without
going through the web UI.

Authentication is handled via BudgetBakers' Next-Auth SSO flow. After the first login the session token is cached
locally, so subsequent runs don't require an SSO email.

Full technical details including all confirmed endpoint shapes, field values, and curl examples are in [api.md](api.md).

---

## Limitations

- **CouchDB only** — this writes directly to the database. If BudgetBakers changes their database infrastructure, the
  tool will need updating.
- **Duplicate detection is batch-scoped** — re-running the same CSV under the same `--batch-id` is safe (duplicates are
  rejected by CouchDB). Re-running without `--batch-id` generates a new batch id and will create duplicates by design,
  so you can intentionally re-import the same data when needed.
- **No edit flow** — record updates are not supported. Rollback supports delete-only, either by recent-record window or
  by import batch id.
