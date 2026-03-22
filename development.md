# Development Practices

Standards and conventions for this project. Every contributor (including future you) follows these without exception.

---

## Table of Contents

1. [Core Philosophy](#core-philosophy)
2. [No Guessing Rule](#no-guessing-rule)
3. [TypeScript](#typescript)
4. [File and Module Structure](#file-and-module-structure)
5. [Naming Conventions](#naming-conventions)
6. [Functions](#functions)
7. [Error Handling](#error-handling)
8. [Constants and Configuration](#constants-and-configuration)
9. [Comments and Documentation](#comments-and-documentation)
10. [Data Integrity](#data-integrity)
11. [Testing Changes Against CouchDB](#testing-changes-against-couchdb)
12. [Git Practices](#git-practices)
13. [What Never Goes in the Repo](#what-never-goes-in-the-repo)

---

## Core Philosophy

This tool writes financial data directly into a live production database. There are no staging environments, no undo buttons, and no soft deletes. Every mistake is permanent until manually corrected inside the app.

Accordingly:

- **Correctness beats cleverness.** A boring, readable solution that is obviously correct is always preferred over a compact one that requires thought to verify.
- **Explicit beats implicit.** Every value that touches CouchDB should be traceable to a confirmed source — a real document, a curl response, a network capture. Nothing should exist because it "seems right."
- **Fail loudly and early.** A row that cannot be resolved should never be silently dropped or written with a fallback value. It goes to the failure CSV with a clear reason.

---

## No Guessing Rule

This is the single most important rule in the project.

**Every field value written to CouchDB must be confirmed from a real document.** If a value has not been verified by fetching an actual record, it does not go in.

In practice this means:

- If you add a new field to `WalletRecord` or `NewRecord`, you must have seen that field in a real document before adding it.
- If you change a constant (e.g. a `paymentType` value), you must have a real record that proves the new value.
- If you are unsure about a field, mark it with a `// TODO: unconfirmed` comment and do not write it until confirmed. Do not guess and assume it will be fine.
- If the app behaviour changes (new fields appear, existing fields change shape), update `types.ts` and `docs/api.md` together — never one without the other.

**How to confirm a value:**

```bash
# Fetch a real record
curl "https://couch-prod-eu-2.budgetbakers.com/bb-{userId}/{docId}" \
  -H "Authorization: Basic {credentials}"

# Fetch 20 records to see a representative sample
curl "{dbUrl}/_all_docs?include_docs=true&startkey=%22Record_%22&endkey=%22Record_%EF%BF%BD%22&limit=20" \
  -H "Authorization: Basic {credentials}"
```

The full curl reference is in [`docs/api.md`](docs/api.md).

---

## TypeScript

### Strict mode is non-negotiable

`tsconfig.json` has `"strict": true`. This must never be loosened. If the compiler complains, fix the types — do not add `// @ts-ignore` or cast to `any`.

```ts
// ✗ Never
const x = foo as any;
const y = (bar as any).baz;

// ✓ Always
const x: KnownType = foo;
```

### Unknown over any

When the shape of data is genuinely unknown (e.g. extra CouchDB fields), use `unknown` and narrow explicitly.

```ts
// ✗
[key: string]: any;

// ✓
[key: string]: unknown;
```

### No implicit returns

Every function that can return a value must always return a value. TypeScript strict mode catches most of these, but be deliberate about it.

### Interfaces over type aliases for object shapes

```ts
// ✗
type LoginResult = { sessionToken: string; userId: string };

// ✓
interface LoginResult {
  sessionToken: string;
  userId:       string;
}
```

Use `type` for unions, intersections, and utility types only.

### Prefer `const` everywhere

Use `let` only when reassignment is genuinely required. Never use `var`.

---

## File and Module Structure

Each file has exactly one responsibility. The current breakdown is:

| File | Responsibility |
|---|---|
| `types.ts` | All shared interfaces — no logic |
| `auth.ts` | Next-Auth SSO flow only |
| `couch.ts` | CouchDB client factory and lookup fetchers |
| `csv.ts` | CSV parsing, conversion, and serialisation |
| `records.ts` | CouchDB `_bulk_docs` write and `getRecord` |
| `cli.ts` | Terminal interaction and output file writing |

**Rules:**

- `types.ts` must have zero imports from other project files. It is the base of the dependency graph.
- `auth.ts` must not import from `couch.ts`, `csv.ts`, or `records.ts`.
- `cli.ts` is the only file allowed to do I/O (stdin, stdout, file system). All other modules are pure functions that receive their dependencies.
- Do not add a seventh file without a clear single-responsibility reason. Prefer extending an existing file if the new code clearly belongs there.

### Import order

Within each file, imports follow this order with a blank line between each group:

1. Node built-ins (`fs`, `path`, `readline`)
2. Third-party packages (`axios`, `csv-parse`, etc.)
3. Local project files (`./auth.js`, `./types.js`, etc.)

```ts
import fs   from "fs";
import path from "path";

import axios from "axios";
import { parse } from "csv-parse/sync";

import { login }       from "./auth.js";
import type { CsvRow } from "./csv.js";
```

---

## Naming Conventions

### Files

`kebab-case.ts` — all lowercase, hyphens for spaces. Current files use short single-word names (`auth`, `couch`, `csv`) which is fine given their narrow scope.

### Variables and functions

`camelCase` for all variables and functions.

```ts
const accountMap = ...;
function buildLookupMaps() { ... }
```

### Interfaces and types

`PascalCase`.

```ts
interface WalletRecord { ... }
interface LoginResult  { ... }
```

### Constants

`SCREAMING_SNAKE_CASE` for module-level constants that represent fixed values.

```ts
const SESSION_FILE   = ".budgetbakers-session";
const RECORD_TYPE    = { INCOME: 0, EXPENSE: 1 } as const;
const CSV_HEADER     = ["date", "account", ...] as const;
```

Use plain `camelCase` for constants that are computed at runtime (e.g. `const couch = buildCouchClient(...)`).

### CouchDB id prefixes

Refer to document types by their full prefix in comments and variable names:

```ts
// ✓ Clear
const accountId  = "-Account_15230f1e-...";
const categoryId = "-Category_8013274a-...";

// ✗ Ambiguous
const id = "15230f1e-...";
```

---

## Functions

### Single responsibility

Each function does one thing. If you find yourself writing a function that "parses and also validates and also converts", split it.

### Explicit parameter and return types

Always annotate function signatures. TypeScript can often infer return types, but explicit annotations serve as documentation and catch unexpected changes.

```ts
// ✗
async function fetchAccounts(couch) {
  ...
}

// ✓
async function fetchAccounts(couch: AxiosInstance): Promise<AccountDoc[]> {
  ...
}
```

### No silent fallbacks

A function that cannot do its job should throw or return a typed failure — not silently substitute a default value that will corrupt data downstream.

```ts
// ✗ Silent fallback — bad data gets written
const categoryId = maps.categories[row.category] ?? "-Category_unknown";

// ✓ Explicit failure — goes to failure CSV with a reason
if (!categoryId) {
  skipped.push({ row, reason: `Unknown category: "${row.category}"` });
  continue;
}
```

### Keep async boundaries explicit

Do not mix async and sync logic inside a single function. If a function needs to do both, split the sync part out.

---

## Error Handling

### Always use `wrapError` for external calls

All calls to axios (both web API and CouchDB) must be wrapped so errors include context and preserve the original stack via `cause`.

```ts
// ✗
const res = await couch.post("/_bulk_docs", { docs });

// ✓
try {
  const res = await couch.post("/_bulk_docs", { docs });
} catch (err) {
  throw wrapError("Writing records failed", err);
}
```

### Never swallow errors silently

```ts
// ✗
try {
  await doSomething();
} catch {
  // ignore
}

// ✓ At minimum, re-throw with context
try {
  await doSomething();
} catch (err) {
  throw wrapError("doSomething failed", err);
}
```

### Distinguish pre-write failures from CouchDB rejections

Pre-write failures (bad account name, invalid amount) go to `skipped` in `convertRows`.  
CouchDB rejections (network error, document conflict) are caught after `writeRecords` returns.  
Both end up in `_failure.csv` but the `reason` column makes the distinction clear to the user.

---

## Constants and Configuration

### Nothing is hardcoded

No CouchDB document ids, currency ids, or category ids are ever hardcoded in the source. Every id is fetched at runtime from CouchDB via `buildLookupMaps`.

```ts
// ✗ Hardcoded — breaks if the user's account has different ids
const NGN_CURRENCY_ID = "-Currency_38481cb0-8314-41fe-b8ce-fd0ff87758be";

// ✓ Fetched at runtime
const currencyId = maps.currencies["NGN"];
```

The only values allowed to be constant in source code are:

- API hostnames (`WEB_ORIGIN`, CouchDB base URL pattern)
- Numeric enum values confirmed from real documents (`RECORD_TYPE`, `PAYMENT_TYPE`)
- CSV structural constants (`CSV_HEADER`, `SESSION_FILE`)

### `as const` on all constant objects

```ts
// ✗
const RECORD_TYPE = { INCOME: 0, EXPENSE: 1 };

// ✓
const RECORD_TYPE = { INCOME: 0, EXPENSE: 1 } as const;
```

This prevents accidental mutation and gives TypeScript the narrowest possible types.

---

## Comments and Documentation

### File-level JSDoc

Every file starts with a `@file` JSDoc block that states:
- What this file does (one sentence)
- Any confirmed facts that are non-obvious
- Any remaining TODOs or unconfirmed values

### Function JSDoc

All exported functions have a JSDoc comment with:
- What it does
- `@param` for non-obvious parameters
- `@returns` if the return value needs explanation
- `@throws` if the function can throw
- `@example` for functions that are called by external code

Private (non-exported) helper functions need a one-line comment if their purpose isn't obvious from the name.

### Inline comments

Use inline comments to explain **why**, not **what**. The code says what. The comment says why.

```ts
// ✗ Obvious what, useless
const amount = Math.round(Math.abs(rawAmount) * 100); // multiply by 100

// ✓ Explains why
// CouchDB stores amounts as positive integers in minor units (×100).
// -53.75 NGN is stored as 5375.
const amount = Math.round(Math.abs(rawAmount) * 100);
```

### Mark unconfirmed values

Any value or behaviour that has not been verified against a real document must be flagged:

```ts
// TODO: unconfirmed — only expense (type=1) has been seen in real records.
// Verify by fetching an income record and checking its `type` field.
const type = rawAmount < 0 ? RECORD_TYPE.EXPENSE : RECORD_TYPE.INCOME;
```

Remove the TODO only after confirmation, and update `docs/api.md` at the same time.

---

## Data Integrity

### Never modify the input file

The original CSV is read-only. Output goes to `_success.csv` and `_failure.csv` alongside it. The input is never overwritten, truncated, or renamed.

### The failure CSV is re-runnable

`_failure.csv` is always written in the same format as the input CSV (with an added `reason` column that `parseCsv` ignores). The user should be able to fix the issues, remove the `reason` column, and re-run the file without any reformatting.

### No duplicate detection — document this clearly

The tool does not check whether a record already exists before writing. Running the same file twice creates duplicates. This is a known limitation documented in `README.md` and must not be silently "fixed" with a half-baked deduplication scheme that could produce false negatives.

If deduplication is added in the future, it must be:
1. Based on a confirmed field (e.g. matching `recordDate` + `amount` + `accountId`)
2. Opt-in via a CLI flag, not the default behaviour
3. Documented in `README.md` and `docs/api.md`

### Amounts are always positive in minor units

```ts
// ✗ Raw signed float from CSV
{ amount: -53.75 }

// ✓ Positive integer in minor units
{ amount: 5375 }
```

This is confirmed from real documents. Any code path that sets `amount` must go through `Math.round(Math.abs(rawAmount) * 100)`.

---

## Testing Changes Against CouchDB

Before any change that affects what gets written to CouchDB:

1. **Read first.** Fetch a sample of real records to understand the current shape:
   ```bash
   curl "{dbUrl}/_all_docs?include_docs=true&startkey=%22Record_%22&endkey=%22Record_%EF%BF%BD%22&limit=20" \
     -H "Authorization: Basic {credentials}"
   ```

2. **Write one record manually.** Before running a full import with a new field, write a single test record and check it in the app:
   ```bash
   curl -X POST "{dbUrl}/_bulk_docs" \
     -H "Authorization: Basic {credentials}" \
     -H "Content-Type: application/json" \
     -d '{"docs": [{ ... }]}'
   ```

3. **Verify in the app.** Open BudgetBakers and confirm the test record appears correctly — right account, right amount, right category, right date and time.

4. **Delete the test record.** CouchDB deletes require a `_rev`. Get it from step 1, then:
   ```bash
   curl -X DELETE "{dbUrl}/Record_{testId}?rev={rev}" \
     -H "Authorization: Basic {credentials}"
   ```

5. **Then run the full import.**

---

## Git Practices

### Commit messages

Format: `<type>: <short description>`

Types:
- `feat` — new capability
- `fix` — bug fix
- `confirm` — update based on newly confirmed field/value from real data
- `docs` — documentation only
- `refactor` — internal restructure, no behaviour change
- `chore` — dependency updates, config changes

```
feat: add payee field to record output
fix: reverse-sort orphan transfer indices before splicing
confirm: type=0 verified for income records
docs: update api.md with paymentType=0 confirmation
```

### One logical change per commit

Do not bundle a bug fix with a refactor. Do not bundle a new feature with documentation updates unless the documentation is specifically about that feature.

### Never commit to main directly

All changes go through a branch and are reviewed before merging — even if you are the only contributor. The review step is what catches the "seemed right at the time" mistakes.

---

## What Never Goes in the Repo

| Item | Why |
|---|---|
| `.budgetbakers-session` | Contains your live session token |
| Any file containing `replication.token` or `replication.login` values | These are production CouchDB credentials |
| Hardcoded user ids, document ids, or CouchDB urls | These are personal to your account |
| `node_modules/` | Reproduced by `npm install` |
| `dist/` | Reproduced by `npm run build` |

Add these to `.gitignore`:

```
.budgetbakers-session
node_modules/
dist/
*.local.*
```
