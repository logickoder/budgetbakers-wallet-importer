/**
 * @file cli/preview.ts
 * @description Builds and prints the pre-write preview block (per-account
 * totals + first-5 sample). Pure formatting — no IO outside the injectable
 * `out` writer.
 */

import { RECORD_TYPE } from "../records.js";
import type { LookupMaps, NewRecord } from "../types.js";

export interface ImportPreviewSummary {
    accountTotals: Array<{ accountName: string; count: number; net: number }>;
    sample: Array<{
        date: string;
        accountName: string;
        amountMinor: number;
        type: 0 | 1;
        categoryName: string;
        note: string;
    }>;
    sampleSize: number;
    totalRecords: number;
}

function reverseMap(map: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, id] of Object.entries(map)) {
        out[id] = name;
    }
    return out;
}

/**
 * Builds a preview summary of converted records grouped per account.
 *
 * `net` is signed minor units (positive = net income, negative = net expense)
 * computed from `type` so income offsets expense correctly.
 */
export function buildImportPreview(records: NewRecord[], maps: LookupMaps): ImportPreviewSummary {
    const accountsById = reverseMap(maps.accounts);
    const categoriesById = reverseMap(maps.categories);

    const totals = new Map<string, { count: number; net: number }>();
    for (const r of records) {
        const name = accountsById[r.accountId] ?? r.accountId;
        const current = totals.get(name) ?? { count: 0, net: 0 };
        const signed = r.type === RECORD_TYPE.EXPENSE ? -r.amount : r.amount;
        current.count += 1;
        current.net += signed;
        totals.set(name, current);
    }

    const accountTotals = [...totals.entries()]
        .map(([accountName, value]) => ({ accountName, ...value }))
        .sort((a, b) => a.accountName.localeCompare(b.accountName));

    const sampleSize = Math.min(records.length, 5);
    const sample = records.slice(0, sampleSize).map((r) => ({
        date: r.recordDate,
        accountName: accountsById[r.accountId] ?? r.accountId,
        amountMinor: r.amount,
        type: r.type,
        categoryName: categoriesById[r.categoryId] ?? r.categoryId,
        note: r.note,
    }));

    return {
        accountTotals,
        sample,
        sampleSize,
        totalRecords: records.length,
    };
}

function formatMinorAmount(minor: number): string {
    const sign = minor < 0 ? "-" : "";
    const abs = Math.abs(minor);
    const whole = Math.trunc(abs / 100);
    const cents = abs % 100;
    return `${sign}${whole}.${cents.toString().padStart(2, "0")}`;
}

/**
 * Prints the preview block. Pure formatting — kept here for testability via
 * an injectable `out` writer.
 */
export function printImportPreview(
    preview: ImportPreviewSummary,
    out: (line: string) => void = (line) => console.log(line)
): void {
    out("");
    out("Preview:");
    out("  Per-account totals:");
    if (preview.accountTotals.length === 0) {
        out("    (none)");
    } else {
        for (const t of preview.accountTotals) {
            out(`    ${t.accountName} · ${t.count} rows · net ${formatMinorAmount(t.net)}`);
        }
    }

    if (preview.sample.length > 0) {
        out(`  First ${preview.sampleSize} of ${preview.totalRecords} record(s):`);
        for (const r of preview.sample) {
            const sign = r.type === RECORD_TYPE.EXPENSE ? "-" : "+";
            const note = r.note ? ` | ${r.note}` : "";
            out(
                `    ${r.date} | ${r.accountName} | ${sign}${formatMinorAmount(r.amountMinor)} | ${r.categoryName}${note}`
            );
        }
    }
}
