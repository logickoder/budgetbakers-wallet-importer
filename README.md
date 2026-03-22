# BudgetBakers CSV Importer

A command-line tool that writes transactions directly into your BudgetBakers / Wallet database — bypassing the official
import pipeline to preserve full timestamps and support multiple accounts in a single file.

---

## Why this exists

The official Wallet app import has two hard limitations:

| Limitation                       | Impact                                                               |
|----------------------------------|----------------------------------------------------------------------|
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

---

## Usage

```bash
npm start
```

Debug logging is enabled by default to help diagnose failures. You can disable it from run params:

```bash
npm start -- --no-debug
```

You can also pass `--debug` explicitly.

The tool will ask for:

1. **Your email address** — used to send an SSO login link on the first run
2. **The SSO token** — paste the link or token from the login email (first run only)
3. **Path to your CSV file**
4. **Confirmation** — shows a summary before writing anything

Your session is saved to `.budgetbakers-session` after the first login. Subsequent runs skip the SSO step entirely until
the session expires.

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
2026-02-10 11:25:00,First Bank,300000,Wage & invoices,,BytebyBit
2026-02-08 16:52:00,First Bank,-8520,Restaurant & fast-food,,Chowdeck
```

### Column reference

| Column     | Required | Format                | Notes                                                |
|------------|----------|-----------------------|------------------------------------------------------|
| `date`     | yes      | `YYYY-MM-DD HH:MM:SS` | Treated as UTC                                       |
| `account`  | yes      | text                  | Must match the account name in the app exactly       |
| `amount`   | yes      | signed number         | Negative = expense, positive = income                |
| `category` | yes      | text                  | Must match the category name in the app exactly      |
| `note`     | no       | text                  | Optional description                                 |
| `payee`    | no       | text                  | Stored as a separate field, not embedded in the note |

### What you don't need to fill in

| Field            | How it's determined                                      |
|------------------|----------------------------------------------------------|
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
|----------------------|-----------------------------------------------------|
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
Same as above for categories. Category names are case-sensitive and must match character for character.

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
│   ├── cli.ts       Entry point — interactive terminal flow and output CSV writing
│   ├── auth.ts      Next-Auth SSO login flow
│   ├── couch.ts     CouchDB client and runtime lookup maps
│   ├── csv.ts       CSV parser, converter, and serialiser
│   ├── records.ts   CouchDB _bulk_docs writer
│   └── types.ts     Shared TypeScript interfaces
├── docs/
│   └── api.md       Full API reference (endpoints, field values, curl examples)
├── package.json
└── tsconfig.json
```

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
- **No delete or edit** — this tool only creates new records.
