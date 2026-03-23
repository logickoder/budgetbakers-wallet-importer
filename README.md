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
git clone <repo>
cd budgetbakers
npm install
```

If published on npm, install globally:

```bash
npm install -g budgetbakers-wallet-importer
```

---

## Usage

```bash
npm start
```

If installed globally from npm:

```bash
budgetbakers-wallet-importer
```

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
```

- `--list-last <count>` lists recent records and exits
- `--rollback-last <count>` lists then deletes those records after confirmation
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

Write 53 records to BudgetBakers? [y/N] y

Writing records...

✓ 53 records written successfully
✗ 2 rows failed
  (2 bad data, 0 CouchDB rejections)

Success CSV → ~/transactions_success.csv
Failure CSV → ~/transactions_failure.csv
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

---

## Project structure

```
budgetbakers/
├── src/
│   ├── cli/
│   │   ├── index.ts       Main orchestration flow
│   │   ├── options.ts     CLI argument parsing and help text
│   │   ├── interaction.ts Prompting and saved-email selection UX
│   │   ├── run.ts         Run helpers + cache/couch lookup resolver
│   │   └── run.test.ts    Cache-hit vs refresh integration harness
│   ├── auth.ts            Next-Auth SSO login flow
│   ├── couch.ts           CouchDB client and runtime lookup maps
│   ├── csv.ts             CSV parser, converter, and serialiser
│   ├── logger.ts          File/console logger with redaction and levels
│   ├── records.ts         CouchDB _bulk_docs writer
│   ├── security/
│   │   └── tokens.ts      Token extraction/validation helpers
│   ├── storage/
│   │   ├── index.ts       Storage barrel exports
│   │   ├── paths.ts       User-path and key resolution
│   │   ├── session.ts     Session index and user session persistence
│   │   ├── cache.ts       Lookup cache read/write
│   │   └── dumps.ts       Debug dump writing and retention pruning
│   ├── types.ts           Shared TypeScript interfaces
├── docs/
│   └── api.md       Full API reference (endpoints, field values, curl examples)
├── package.json
└── tsconfig.json
```

### Architecture overview

- `cli/index.ts` coordinates flow only.
- `cli/options.ts` handles all flag validation.
- `cli/interaction.ts` handles all interactive questions.
- `cli/run.ts` contains run utilities and testable cache-resolution logic.
- `storage/*` owns persistence concerns (session index, per-user cache, dump and log file housekeeping).
- `security/tokens.ts` isolates token extraction/validation utilities.
- `auth.ts`, `couch.ts`, `records.ts`, and `csv.ts` stay focused on external integrations and data conversion.

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

Full technical details including all confirmed endpoint shapes, field values, and curl examples are in [
`docs/api.md`](docs/api.md).

---

## Limitations

- **CouchDB only** — this writes directly to the database. If BudgetBakers changes their database infrastructure, the
  tool will need updating.
- **No duplicate detection** — running the same CSV twice will create duplicate records. Use the `_success.csv` output
  to track what has already been imported.
- **No edit flow** — record updates are not supported. Rollback supports delete-only for targeted recent records.
