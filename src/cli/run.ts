import path from "path";

import type { Logger } from "../logger.js";
import type { LookupCacheSnapshot, LookupData, LookupMaps, NewRecord } from "../types.js";
import { RECORD_TYPE } from "../records.js";

export interface ResolveLookupInputs {
    email: string;
    userId: string;
    refreshCache: boolean;
    loadCache: (email: string) => LookupCacheSnapshot | null;
    fetchLookupData: () => Promise<LookupData>;
    buildLookupMaps: (data: LookupData) => LookupMaps;
    persistCache: (email: string, userId: string, data: LookupData, maps: LookupMaps) => void;
    log: Logger;
}

export interface ResolveLookupResult {
    source: "cache" | "couch";
    lookupData: LookupData;
    maps: LookupMaps;
    durationMs: number;
}

export function makeRunId(): string {
    return new Date().toISOString().replace(/[.:]/g, "-");
}

/**
 * Derives output file paths from the input CSV path.
 */
export function outputPaths(inputPath: string): { success: string; failure: string } {
    const dir = path.dirname(inputPath);
    const ext = path.extname(inputPath);
    const base = path.basename(inputPath, ext);
    return {
        success: path.join(dir, `${base}_success${ext}`),
        failure: path.join(dir, `${base}_failure${ext}`),
    };
}

/**
 * Cache-first lookup resolution with explicit refresh override.
 * This is extracted for testability and deterministic behavior checks.
 */
export async function resolveLookupData(inputs: ResolveLookupInputs): Promise<ResolveLookupResult> {
    const start = Date.now();

    if (!inputs.refreshCache) {
        const cached = inputs.loadCache(inputs.email);
        if (cached && cached.metadata.userId === inputs.userId) {
            inputs.log("Lookup cache hit", {
                generatedAt: cached.metadata.generatedAt,
            });
            return {
                source: "cache",
                lookupData: cached.data,
                maps: cached.maps,
                durationMs: Date.now() - start,
            };
        }
    }

    inputs.log("CouchDB lookup fetch started");
    const lookupData = await inputs.fetchLookupData();
    const maps = inputs.buildLookupMaps(lookupData);
    inputs.persistCache(inputs.email, inputs.userId, lookupData, maps);
    inputs.log("CouchDB lookup fetch finished", {
        accounts: lookupData.accounts.length,
        categories: lookupData.categories.length,
        currencies: lookupData.currencies.length,
    });

    return {
        source: "couch",
        lookupData,
        maps,
        durationMs: Date.now() - start,
    };
}

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
