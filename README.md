# BudgetBakers Wallet Importer

Writes transactions straight into your BudgetBakers / Wallet CouchDB database from a CSV.

It bypasses the official app import, which strips two things you probably want:

- Time of day. The app import accepts `yyyy-MM-dd` only, so every transaction lands at midnight. This tool keeps timestamps to the second.
- Multiple accounts. The app import takes one account per file. This tool lets every row target a different account.

## Quickstart

```bash
npm install -g budgetbakers-wallet-importer
budgetbakers-wallet-importer --csv ./transactions.csv --dry-run   # preview, no write
budgetbakers-wallet-importer --csv ./transactions.csv             # import
```

`--dry-run` parses the CSV, resolves accounts and categories against your CouchDB lookups, prints the preview, and exits without writing.

## Requirements

- Node.js 18+
- A BudgetBakers / Wallet account

## Install

From npm, globally:

```bash
npm install -g budgetbakers-wallet-importer
```

From source:

```bash
git clone https://github.com/logickoder/budgetbakers-wallet-importer.git
cd budgetbakers-wallet-importer
pnpm install   # or: npm install
npm start
```

`pnpm` is the canonical package manager. `npm` works too. Mixing them produces lockfile noise.

## Usage

Run interactively:

```bash
npm start
```

The tool asks for:

1. Email. Choose a saved email or type a new one.
2. SSO token. Only when no valid saved session exists.
3. CSV path.
4. Confirmation. A summary prints before anything is written.

### CLI flags

| Flag                       | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `--email <email>`          | Use this email. Skips the email prompt.                                  |
| `--csv <path>`             | Use this CSV path. Skips the path prompt.                                |
| `--from-bankstract <path>` | Import a [bankstract](#importing-from-bankstract) export (JSON or CSV).  |
| `--bank <id>`              | Bank id for bankstract CSV input (`fbn`/`opay`/`palmpay`/`zenith`).      |
| `--bank-map <path>`        | JSON map of bank id to app account name, e.g. `{"fbn":"First Bank"}`.    |
| `--default-category <name>`| Category applied to every bankstract row.                                |
| `--convert-only [out.csv]` | Convert bankstract input to importer CSV and exit. Edit before import.   |
| `--yes`, `-y`              | Auto-confirm the write prompt (and rollback prompts).                    |
| `--dry-run`, `--validate`  | Parse, preview, exit. No CouchDB write.                                  |
| `--batch-id <uuid>`        | Reuse an import batch id. Makes re-runs idempotent.                      |
| `--rollback-import <uuid>` | Delete every record tagged with that import batch id.                    |
| `--list-last <count>`      | List the N most recently created Record docs and exit.                   |
| `--rollback-last <count>`  | Delete the N most recently created Record docs, after confirmation.      |
| `--start-ts <iso>`         | Lower bound when filtering `--list-last` / `--rollback-last` by created. |
| `--end-ts <iso>`           | Upper bound for the same.                                                |
| `--refresh-cache`          | Force a fresh lookup fetch from CouchDB instead of the cache.            |
| `--debug` / `--no-debug`   | Toggle console logs. Debug is on by default. File log is always on.      |
| `--log-level <level>`      | Minimum level written to the run log file (`info`/`warn`/`error`).       |
| `-h`, `--help`             | Print help and exit.                                                     |

Non-interactive run:

```bash
npm start -- --email you@example.com --csv ./transactions.csv --yes
```

`--email` skips the email prompt, `--csv` skips the path prompt, `--yes` skips the write confirmation.

### Logging

Console verbosity is controlled by `--debug` / `--no-debug`. Debug is on by default. Set the file log level with `--log-level`:

```bash
npm start -- --no-debug --log-level warn
```

A run log is always written per user at `./data/<user-hash>/logs/importer-<timestamp>.log`, regardless of console mode. Logs are pruned to the latest 40 per user.

With debug on, the importer also writes CouchDB lookup dumps under `./data/<user-hash>/debug/couch-lookups-<timestamp>/` (`metadata.json`, `accounts.json`, `categories.json`, `currencies.json`, `maps.json`). Dumps are pruned to the latest 20 per user.

Sessions are indexed in `.budgetbakers-session.json` (email to session details) and stored per user in `data/<user-hash>/session.json`. Lookup data is cached in that same directory and reused by default. Force a fresh fetch with `--refresh-cache`.

## Import batches and rollback

Every run generates a fresh import batch id (a UUID). It is:

- Printed after the preview block.
- Tagged on every written record via `importBatchId`.
- Used to derive each record's CouchDB `_id` via UUIDv5.

Two consequences:

1. Re-running the same CSV under the same batch id is safe. Identical rows produce identical `_id`s, so CouchDB rejects them with a 409 `conflict` and the importer reports duplicates instead of writing them again.
2. Targeted rollback. Delete every record from one run with `--rollback-import <batch-id>`. No time-window guessing.

Reuse a batch id to resume a partial import:

```bash
npm start -- --csv ./transactions.csv --batch-id <uuid-from-previous-run>
```

A run without `--batch-id` gets a new id, so an intentional re-import of the same CSV still works.

Rollback helpers:

```bash
# Preview the last 20 published Record docs
npm start -- --list-last 20

# Preview the last 20 within a timestamp window
npm start -- --list-last 20 --start-ts "2026-03-23T08:00:00Z" --end-ts "2026-03-23T09:00:00Z"

# Delete the last 20 published Record docs
npm start -- --rollback-last 20

# Delete the last 20 within a timestamp window
npm start -- --rollback-last 20 --start-ts "2026-03-23T08:00:00Z" --end-ts "2026-03-23T09:00:00Z"

# Delete every record tagged with a specific import batch id
npm start -- --rollback-import 617b1204-9ef6-4bfa-8b04-03d0d509d7db
```

Timestamp filters apply after fetching the requested last `<count>` records. Add `--yes` to skip the confirmation prompt in rollback mode.

If the app looks wrong after an import, run `--rollback-last` to revert the most recent records, check the failure CSV for what broke (for example an invalid date), fix the source, and re-run.

## Importing from bankstract

[bankstract](https://github.com/logickoder/bankstract) turns Nigerian bank PDF/XLSX statements into structured data. This importer reads its exports directly, so you go from a bank statement to imported records without hand-building a CSV.

bankstract knows nothing about your app's account names or categories. You supply those two fields:

| bankstract to importer | Source                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| `account`              | `--bank-map` (bank id to account name), keyed by the statement bank |
| `category`             | `--default-category` (one category for every row)                  |
| `amount`               | derived as `credit - debit`, signed                                |
| `note`                 | the narration, with the reference folded in when present           |

Nothing is guessed. Any row whose account or category can't be resolved is left blank (convert-only) or sent to the failure CSV (direct import).

JSON is the preferred input. It carries the bank id in its metadata, so `--bank-map` resolves the account on its own. CSV exports have no bank column, so pass `--bank <id>` alongside them.

### The bank map

A flat JSON object. Keys are bankstract bank ids (`fbn`, `opay`, `palmpay`, `zenith`), values are the exact account names as they appear in your app. Save it once, reuse it across runs.

```json
{
  "fbn": "First Bank",
  "opay": "OPay",
  "palmpay": "Palmpay",
  "zenith": "Zenith"
}
```

### Convert, edit, then import

Reshape the bankstract export into the importer's own CSV and stop. Review or edit it (fix categories, split accounts) in Excel or a text editor, then import the result with `--csv`:

```bash
npm start -- --from-bankstract statement.json --bank-map banks.json --convert-only
# writes statement.imported.csv, then:
npm start -- --csv statement.imported.csv
```

`--convert-only` needs nothing else. Omit the map and category and those columns come out blank for you to fill. Pass an explicit output path with `--convert-only out.csv`.

### Import directly

Skip the intermediate file. Every row gets the mapped account and the default category:

```bash
npm start -- --from-bankstract statement.json \
  --bank-map banks.json \
  --default-category "Uncategorised"
```

For a CSV export, add the bank id:

```bash
npm start -- --from-bankstract statement.csv --bank fbn \
  --bank-map banks.json --default-category "Uncategorised"
```

Re-categorise the rows inside the Wallet app afterwards, or use convert-only and set categories per row before importing.

## CSV format

Six columns:

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

### Columns

| Column     | Required | Format                | Notes                                                |
| ---------- | -------- | --------------------- | ---------------------------------------------------- |
| `date`     | yes      | `YYYY-MM-DD HH:MM:SS` | Interpreted as local time. Preserves the entered hour. |
| `account`  | yes      | text                  | Must match the account name in the app exactly.      |
| `amount`   | yes      | signed number         | Negative is expense, positive is income.             |
| `category` | yes      | text                  | Must match the category name in the app exactly.     |
| `note`     | no       | text                  | Optional description.                                 |
| `payee`    | no       | text                  | Stored as a separate field, not embedded in the note. |

Dates:

- The importer writes `recordDate` as `YYYY-MM-DDTHH:mm:ss.SSS±HH:mm`.
- Input dates are read as local wall-clock time and normalized before upload.
- Supported input includes `YYYY-MM-DD HH:MM:SS`, `YYYY-MM-DDTHH:MM:SS`, and `M/D/YYTHH:mm(.SSS)(±HH:mm)`.

### Auto-filled fields

| Field            | How it's determined                                     |
| ---------------- | ------------------------------------------------------- |
| Currency         | Taken from the account's own currency. No column needed. |
| Income / expense | Sign of `amount`.                                       |
| Transfer flag    | Detected automatically. See Transfers.                  |
| Payment type     | Electronic for transfers, cash for everything else.     |

### Transfers

Write two rows with the same `date` and category `Transfer` (or whatever you named the transfer category in the app). The importer links them automatically.

```csv
2026-01-29 13:33:00,First Bank,-300000,Transfer,,
2026-01-29 13:33:00,Palmpay,300000,Transfer,,
```

The category name and the timestamp must both match for the pair to link. A transfer row with no matching second leg is moved to the failure file with a reason.

## Output files

Each run writes two files next to your input CSV:

| File                 | Contents                                            |
| -------------------- | --------------------------------------------------- |
| `<name>_success.csv` | Rows written to BudgetBakers successfully.          |
| `<name>_failure.csv` | Rows that failed, with an extra `reason` column.    |

The failure file is already in the importer CSV format. Fix the issues, rename it, and re-run it as the input.

Duplicate rows (CouchDB 409 `conflict` because the same `_id` already exists in this batch) are reported in the console and counted in the run log. They are not written to either output CSV, since they are neither new successes nor failures. Re-import them under a fresh batch id (drop `--batch-id`).

### Example run

```
── BudgetBakers CSV Importer ──

Found saved session. Skipping SSO.

Logged in as you@example.com

Fetching accounts, categories and currencies from CouchDB...
  18 accounts  ·  62 categories  ·  2 currencies

Path to CSV file: ~/transactions.csv

Parsing CSV...

  Total rows:         55
  Ready to import:    53
  Skipped (bad data): 2

  Skipped reasons:
    [2×] Unknown category: "Food"

Preview:
  Per-account totals:
    First Bank · 47 rows · net -125300.50
    Palmpay    · 6 rows  · net  300000.00

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

## Common errors

**`Unknown account: "First Bank"`**
The CSV account name does not match the app. Open the app, check the name, update your CSV.

**`Unknown category: "Food"`**
Same, for categories. Category names are case-sensitive and must match character for character. Transfer aliases like `TRANSFER` and `Transfer` map to the app's transfer category.

**`Transfer row has no matching pair`**
A transfer-category row has no second row with the same timestamp. Check that both legs carry the exact same `date` string.

**`Session expired, starting fresh SSO flow`**
Your saved session token expired. The tool clears the old token and triggers a new SSO email automatically.

**`↻ N duplicate(s) skipped (already in batch ...)`**
Not an error. Rows with the same identity were already written under this batch id, so CouchDB rejected the duplicates. To write them again, drop `--batch-id` and re-run for fresh `_id`s.

## Project structure

```
budgetbakers-wallet-importer/
├── src/
│   ├── cli/
│   │   ├── index.ts       Main orchestration flow
│   │   ├── interaction.ts Prompting and saved-email selection
│   │   ├── maintenance.ts List/rollback flows (last-N and by import batch)
│   │   ├── options/
│   │   │   ├── index.ts   CLI options entry, help/exit behavior
│   │   │   ├── core.ts    Pure argument parsing and validation
│   │   │   └── types.ts   Shared RunOptions interface
│   │   ├── preview.ts     Per-account preview builder and printer
│   │   └── run.ts         Run id, output paths, cache/couch lookup resolver
│   ├── auth.ts            Next-Auth SSO login flow
│   ├── bankstract.ts      bankstract JSON/CSV adapter to importer rows
│   ├── couch.ts           CouchDB client and runtime lookup maps
│   ├── csv.ts             CSV parser, converter, and serializer
│   ├── date-time.ts       Local date parsing and ISO normalization
│   ├── logger.ts          File/console logger with redaction and levels
│   ├── records.ts         _bulk_docs writer, UUIDv5 _id, batch views
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
│   │   ├── bankstract.test.ts
│   │   ├── csv.test.ts
│   │   ├── date-time.test.ts
│   │   └── records.test.ts
│   └── types.ts           Shared TypeScript interfaces
├── api.md                 Full API reference (endpoints, field values, curl)
├── development.md         Coding conventions and the no-guessing rule
├── package.json
├── pnpm-lock.yaml
└── tsconfig.json
```

## How it works

BudgetBakers stores all data in a personal CouchDB database:

```
https://couch-prod-eu-2.budgetbakers.com/bb-{userId}/
```

The mobile and web apps sync to this database via PouchDB. This tool authenticates with the same credentials the app uses and writes `Record` documents directly via `_bulk_docs`, the same way the app does, minus the web UI.

Auth runs through BudgetBakers' Next-Auth SSO flow. After the first login the session token is cached locally, so later runs skip the SSO email.

Full endpoint shapes, field values, and curl examples are in [api.md](api.md).

## Limitations

- CouchDB only. This writes directly to the database. If BudgetBakers changes their infrastructure, the tool needs updating.
- Duplicate detection is batch-scoped. Re-running the same CSV under the same `--batch-id` is safe. Re-running without one generates a new batch id and creates duplicates by design, so intentional re-imports work.
- No edit flow. Record updates are not supported. Rollback is delete-only, by recent-record window or by import batch id.
```
