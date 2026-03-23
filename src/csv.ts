/**
 * @file csv.ts
 * @description Parser for the custom BudgetBakers importer CSV format.
 *
 * ## Custom format (simpler than the official Wallet export)
 *
 * ```csv
 * date,account,amount,category,note,payee
 * 2026-01-27 02:31:00,First Bank,-53.75,Charges & Fees,Stamp Duty,
 * 2026-01-29 13:33:00,First Bank,-300000,Transfer,,
 * 2026-01-29 13:33:00,Palmpay,300000,Transfer,,
 * 2026-02-10 11:25:00,First Bank,300000,Wage & invoices,,Company XYZ
 * ```
 *
 * ### Columns
 * | Column     | Required | Notes                                              |
 * |------------|----------|----------------------------------------------------|
 * | `date`     | yes      | `YYYY-MM-DD HH:MM:SS` — interpreted as local time  |
 * | `account`  | yes      | Exact account name as it appears in the app        |
 * | `amount`   | yes      | Signed float. Negative = expense, positive = income|
 * | `category` | yes      | Exact app category name, except transfer aliases   |
 * | `note`     | no       | Free text                                          |
 * | `payee`    | no       | Stored as a separate field, not embedded in note   |
 *
 * ### What you don't need to specify
 * - **Currency** — derived from the account's own currency at runtime
 * - **Transfer flag** — detected when category is "Transfer, withdraw" (or
 *   whatever the user named it) AND both rows share the same timestamp
 * - **Payment type** — derived from category: transfer rows → 3, others → 0
 * - **Type (income/expense)** — derived from the sign of `amount`
 *
 * ### Transfer pair rules
 * Two rows form a transfer pair when ALL of:
 *   1. Both have the same category that maps to the "Transfer, withdraw" id
 *   2. Both share the exact same `date` string
 * The pair is linked via a shared `transferId` UUID, with each leg pointing
 * to the other's account in `transferAccountId`.
 */

import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { DateTime } from "luxon";
import { RECORD_TYPE, PAYMENT_TYPE } from "./records.js";
import type { LookupMaps, NewRecord } from "./types.js";

/** Raw row shape after csv-parse with `columns: true`. */
export interface CsvRow {
  date: string;
  account: string;
  amount: string;
  category: string;
  note: string;
  payee: string;
}

/** A row that could not be converted, with a reason. */
export interface SkippedRow {
  row: CsvRow;
  reason: string;
}

/** Result from `convertRows`. */
export interface ParseResult {
  records: NewRecord[];
  /**
   * The original CSV row for each record, in the same order.
   * `originalRows[i]` is the source row for `records[i]`.
   * Used by cli.ts to write `_success.csv` and `_failure.csv`.
   */
  originalRows: CsvRow[];
  skipped: SkippedRow[];
}

/** The header for our custom CSV format. */
export const CSV_HEADER = ["date", "account", "amount", "category", "note", "payee"] as const;

/**
 * Transfer rows are a special case: we accept common aliases and map them
 * to the runtime "Transfer, withdraw" category id when available.
 */
function isTransferCategoryAlias(category: string): boolean {
  const normalized = category
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();

  return normalized === "transfer" || normalized === "transfer withdraw";
}

/**
 * Parses the custom importer CSV string into raw row objects.
 * Strips the UTF-8 BOM and skips blank lines.
 */
export function parseCsv(content: string): CsvRow[] {
  return parse(content.replace(/^\uFEFF/, ""), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as CsvRow[];
}

/**
 * Converts a date string from the custom format to full ISO-8601.
 *
 * The CSV value is treated as local wall-clock time so the app shows the
 * same hour the user entered.
 *
 * Input:  `"2026-01-27 02:31:00"`
 * Output: `"2026-01-27T02:31:00.000+01:00"` (offset varies by machine/date)
 */
const DATE_INPUT_FORMATS = [
  "yyyy-MM-dd HH:mm:ss",
  "yyyy-MM-dd HH:mm",
  "yyyy-MM-dd'T'HH:mm:ss",
  "yyyy-MM-dd'T'HH:mm",
  "M/d/yy H:mm:ss.SSS",
  "M/d/yy H:mm:ss",
  "M/d/yy H:mm.SSS",
  "M/d/yy H:mm",
  "M/d/yyyy H:mm:ss.SSS",
  "M/d/yyyy H:mm:ss",
  "M/d/yyyy H:mm.SSS",
  "M/d/yyyy H:mm",
  "M/d/yy'T'H:mm:ss.SSS",
  "M/d/yy'T'H:mm:ss",
  "M/d/yy'T'H:mm.SSS",
  "M/d/yy'T'H:mm",
  "M/d/yyyy'T'H:mm:ss.SSS",
  "M/d/yyyy'T'H:mm:ss",
  "M/d/yyyy'T'H:mm.SSS",
  "M/d/yyyy'T'H:mm",
] as const;

function stripTrailingOffset(raw: string): string {
  return raw.trim().replace(/(?:Z|[+-]\d{2}:\d{2})$/i, "");
}

function parseAsLocalDateTime(raw: string): DateTime | null {
  const cleaned = stripTrailingOffset(raw);

  for (const fmt of DATE_INPUT_FORMATS) {
    const parsed = DateTime.fromFormat(cleaned, fmt, {
      zone: "local",
      setZone: false,
      locale: "en-US",
    });
    if (parsed.isValid) return parsed;
  }

  const isoParsed = DateTime.fromISO(cleaned, {
    zone: "local",
    setZone: false,
  });

  if (isoParsed.isValid) return isoParsed;
  return null;
}

export function toIso(date: string): string {
  const parsed = parseAsLocalDateTime(date);
  if (!parsed) {
    throw new Error(`Invalid date: "${date}"`);
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZZ");
}

/**
 * Serialises a list of CsvRow objects back to a CSV string with header.
 * Used when writing `_success.csv` and `_failure.csv`.
 */
export function rowsToCsv(rows: CsvRow[]): string {
  if (rows.length === 0) return CSV_HEADER.join(",") + "\n";
  return stringify(rows, { header: true, columns: CSV_HEADER as unknown as string[] });
}

/**
 * Serialises skipped rows (with their failure reason) to a CSV string.
 * Adds a `reason` column so the user knows exactly what went wrong.
 */
export function skippedRowsToCsv(skipped: SkippedRow[]): string {
  const columns = [...CSV_HEADER, "reason"];
  if (skipped.length === 0) return columns.join(",") + "\n";
  const data = skipped.map(({ row, reason }) => ({ ...row, reason }));
  return stringify(data, { header: true, columns });
}

/**
 * Converts parsed CSV rows to `NewRecord` objects using runtime lookup maps.
 *
 * Resolution logic:
 * - `accountId`   — maps.accounts[row.account]         (full -Account_ id)
 * - `currencyId`  — maps.accountCurrencies[row.account] (no CSV column needed)
 * - `categoryId`  — maps.categories[row.category]      (full -Category_ id)
 * - `type`        — sign of amount: negative → EXPENSE, positive → INCOME
 * - `paymentType` — transfer rows → TRANSFER (3), everything else → CASH (0)
 * - `transfer`    — true when categoryId === maps.transferCategoryId
 *
 * Transfer pair linking:
 * - Pairs identified by: same category (transfer) + same date string
 * - Using both conditions is more robust than timestamp alone
 * - Each pair gets a shared `transferId` UUID; each leg gets the other's
 *   accountId in `transferAccountId`
 *
 * The returned `originalRows` array is parallel to `records` — index i in
 * `originalRows` is the source CSV row for `records[i]`. This allows cli.ts
 * to write success/failure output CSVs after the CouchDB write completes.
 */
export function convertRows(rows: CsvRow[], maps: LookupMaps): ParseResult {
  const records: NewRecord[] = [];
  const originalRows: CsvRow[] = [];
  const skipped: SkippedRow[] = [];

  // Track pending transfer legs. Key: date string. Value: index into `records`.
  const pendingTransfers = new Map<string, number>();

  for (const row of rows) {
    if (!row.date?.trim() || !row.account?.trim()) continue;

    // ── Resolve CouchDB ids ─────────────────────────────────────────────────
    const accountId = maps.accounts[row.account];
    const currencyId = maps.accountCurrencies[row.account];

    const rawCategory = row.category?.trim() || "";
    let categoryId = maps.categories[rawCategory];

    if (!categoryId && maps.transferCategoryId !== null && isTransferCategoryAlias(rawCategory)) {
      categoryId = maps.transferCategoryId;
    }

    if (!accountId) {
      skipped.push({ row, reason: `Unknown account: "${row.account}"` });
      continue;
    }
    if (!currencyId) {
      skipped.push({ row, reason: `No currency found for account: "${row.account}"` });
      continue;
    }
    if (!categoryId) {
      skipped.push({ row, reason: `Unknown category: "${row.category}" — check app for exact name` });
      continue;
    }

    // ── Amount → minor units ────────────────────────────────────────────────
    const rawAmount = parseFloat(row.amount);
    if (isNaN(rawAmount)) {
      skipped.push({ row, reason: `Invalid amount: "${row.amount}"` });
      continue;
    }
    const amount = Math.round(Math.abs(rawAmount) * 100);

    // ── Derived fields ──────────────────────────────────────────────────────
    const type = rawAmount < 0 ? RECORD_TYPE.EXPENSE : RECORD_TYPE.INCOME;
    let recordDate: string;
    try {
      recordDate = toIso(row.date);
    } catch {
      skipped.push({
        row,
        reason: `Invalid date: "${row.date}" — expected a parseable local date/time`,
      });
      continue;
    }

    const isTransfer = maps.transferCategoryId !== null
      && categoryId === maps.transferCategoryId;

    const paymentType = isTransfer ? PAYMENT_TYPE.TRANSFER : PAYMENT_TYPE.CASH;

    const record: NewRecord = {
      accountId,
      currencyId,
      categoryId,
      amount,
      type,
      note: row.note?.trim() || "",
      payee: row.payee?.trim() || undefined,
      recordDate,
      paymentType,
      transfer: isTransfer,
    };

    // ── Transfer pair linking ───────────────────────────────────────────────
    if (isTransfer) {
      const pairKey = row.date.trim();
      const pairIdx = pendingTransfers.get(pairKey);

      if (pairIdx !== undefined) {
        const sharedTransferId = crypto.randomUUID();
        const firstLeg = records[pairIdx];

        firstLeg.transferId = sharedTransferId;
        firstLeg.transferAccountId = accountId;

        record.transferId = sharedTransferId;
        record.transferAccountId = firstLeg.accountId;

        pendingTransfers.delete(pairKey);
      } else {
        pendingTransfers.set(pairKey, records.length);
      }
    }

    records.push(record);
    originalRows.push(row);
  }

  // Move any unmatched transfer legs to skipped.
  // Iterate in reverse so splicing doesn't shift subsequent indices.
  const orphanIndices = [...pendingTransfers.values()].sort((a, b) => b - a);
  for (const idx of orphanIndices) {
    const orphanRow = originalRows[idx];
    skipped.push({
      row: orphanRow,
      reason: `Transfer row at "${orphanRow.date}" has no matching pair — both legs must have the same date`,
    });
    records.splice(idx, 1);
    originalRows.splice(idx, 1);
  }

  return { records, originalRows, skipped };
}
