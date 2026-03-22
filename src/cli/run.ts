import path from "path";

import type { Logger } from "../logger.js";
import type { LookupCacheSnapshot, LookupData, LookupMaps } from "../types.js";

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
