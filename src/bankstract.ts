/**
 * @file bankstract.ts
 * @description Adapter: bankstract statement exports (JSON/CSV) → importer CsvRow[].
 *
 * bankstract (https://github.com/logickoder/bankstract) parses Nigerian bank
 * PDF/XLSX statements into a neutral schema. Its rows have no concept of the
 * user's app account names or categories, so this adapter bridges the gap:
 *
 *   - account  ← bank→account map keyed by the statement's bank id
 *   - amount   ← credit − debit, signed (negative = expense, positive = income)
 *   - category ← a single default category (user re-categorises in-app)
 *   - note     ← narration (with the reference folded in when present)
 *
 * Anything unresolved is left blank. In direct-import mode, downstream
 * `convertRows` routes blank account/category rows to the failure CSV. This
 * adapter never guesses a value (see the No Guessing Rule in development.md).
 *
 * ## bankstract input shapes
 *
 * JSON (preferred, carries `metadata.bank`, so the map resolves automatically):
 * ```json
 * {
 *   "metadata": { "bank": "fbn", ... },
 *   "transactions": [
 *     { "date": "2026-01-27T02:31:00", "narration": "...", "debit": "0",
 *       "credit": "300000", "balance": "...", "reference": "...", "currency": "NGN" }
 *   ]
 * }
 * ```
 *
 * CSV (no bank column, supply the bank id via `--bank` to resolve the map):
 * ```csv
 * date,narration,debit,credit,balance,reference,currency
 * 2026-01-27T02:31:00,Stamp Duty,53.75,0,,,NGN
 * ```
 */

import fs from "fs";
import { parse } from "csv-parse/sync";
import type { CsvRow } from "./csv.js";

/** A single bankstract transaction (JSON `transactions[]` entry or CSV row). */
export interface BankstractTransaction {
    date: string;
    narration: string;
    /** Decimal string. "0" (or blank) when the row is a credit. */
    debit: string;
    /** Decimal string. "0" (or blank) when the row is a debit. */
    credit: string;
    balance?: string | null;
    reference?: string | null;
    currency?: string | null;
}

/** The top-level bankstract JSON document (only the fields we consume). */
export interface BankstractJson {
    metadata?: { bank?: string | null } | null;
    transactions: BankstractTransaction[];
}

/** Maps a bankstract bank id (e.g. "fbn") to an exact app account name. */
export type BankMap = Record<string, string>;

/** Normalised bankstract input: resolved bank id plus its transactions. */
export interface BankstractInput {
    /** The bank id from JSON metadata or the `--bank` override; null if unknown. */
    bank: string | null;
    transactions: BankstractTransaction[];
}

/**
 * Reads a bankstract export from disk and normalises it.
 *
 * Format is detected from the extension, falling back to the first
 * non-whitespace byte (`{`/`[` → JSON, otherwise CSV).
 *
 * @param bankOverride Bank id from `--bank`. Takes precedence over JSON
 *   metadata, and is the only bank source for CSV input (which has no bank
 *   column).
 */
export function readBankstractInput(filePath: string, bankOverride: string | null): BankstractInput {
    const raw = fs.readFileSync(filePath, "utf8");
    const trimmed = raw.replace(/^\uFEFF/, "").trimStart();
    const looksJson =
        filePath.toLowerCase().endsWith(".json") || trimmed.startsWith("{") || trimmed.startsWith("[");

    if (looksJson) {
        let doc: BankstractJson;
        try {
            doc = JSON.parse(trimmed) as BankstractJson;
        } catch (error) {
            throw new Error(
                `Failed to parse bankstract JSON: ${error instanceof Error ? error.message : String(error)}`
            );
        }
        if (!Array.isArray(doc.transactions)) {
            throw new Error("bankstract JSON is missing a 'transactions' array.");
        }
        return {
            bank: bankOverride ?? doc.metadata?.bank ?? null,
            transactions: doc.transactions,
        };
    }

    return { bank: bankOverride, transactions: parseBankstractCsv(raw) };
}

/** Parses bankstract's CSV export into transactions. */
function parseBankstractCsv(content: string): BankstractTransaction[] {
    const rows = parse(content.replace(/^\uFEFF/, ""), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
    }) as Record<string, string>[];

    return rows.map((r) => ({
        date: r.date ?? "",
        narration: r.narration ?? "",
        debit: r.debit ?? "0",
        credit: r.credit ?? "0",
        balance: r.balance ?? null,
        reference: r.reference ?? null,
        currency: r.currency ?? null,
    }));
}

/**
 * Converts normalised bankstract input to importer `CsvRow`s.
 *
 * The `account` is resolved from `bankMap[input.bank]` and `category` from
 * `defaultCategory`; either is left blank when unavailable. Blank cells are
 * intentional. Convert-only output leaves them for the user to fill, and
 * direct import lets `convertRows` reject them loudly.
 */
export function bankstractToCsvRows(
    input: BankstractInput,
    bankMap: BankMap,
    defaultCategory: string
): CsvRow[] {
    const account = input.bank ? bankMap[input.bank] ?? "" : "";

    return input.transactions.map((tx) => ({
        date: (tx.date ?? "").trim(),
        account,
        amount: signedAmount(tx),
        category: defaultCategory,
        note: buildNote(tx),
        payee: "",
    }));
}

/**
 * Loads a bank→account map from a JSON file: `{ "fbn": "First Bank", ... }`.
 * Throws on any shape that is not a flat object of string values.
 */
export function loadBankMap(filePath: string): BankMap {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `Failed to parse bank map JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Bank map must be a JSON object of { bankId: accountName }.");
    }

    const map: BankMap = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") {
            throw new Error(`Bank map value for "${key}" must be a string.`);
        }
        map[key] = value;
    }
    return map;
}

/**
 * Signed amount as a decimal string: `credit − debit`.
 *
 * Computed in integer minor units to avoid binary-float drift, then rendered
 * back to a decimal string the importer's `parseFloat` reads (e.g. "-53.75").
 */
function signedAmount(tx: BankstractTransaction): string {
    const minor = toMinorUnits(tx.credit) - toMinorUnits(tx.debit);
    return String(minor / 100);
}

/** Parses a decimal string to integer minor units (cents). Blank → 0. */
function toMinorUnits(value: string | null | undefined): number {
    const text = (value ?? "").trim();
    if (text === "") return 0;
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid numeric value in bankstract row: "${value}"`);
    }
    return Math.round(parsed * 100);
}

/** Builds the note from narration, folding in the reference when present. */
function buildNote(tx: BankstractTransaction): string {
    const narration = (tx.narration ?? "").trim();
    const reference = (tx.reference ?? "").trim();
    if (reference && !narration) return `Ref: ${reference}`;
    if (reference) return `${narration} (Ref: ${reference})`;
    return narration;
}
