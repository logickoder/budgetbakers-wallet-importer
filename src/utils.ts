import fs from "fs";
import path from "path";

import type {LookupData, LookupMaps} from "./types.js";

function extractTokenLike(value: unknown, keys: string[]): string | null {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return null;

    const obj = value as Record<string, unknown>;
    for (const key of keys) {
        if (typeof obj[key] === "string") return obj[key] as string;
    }
    return null;
}

export function requireTokenString(value: unknown, field: string): string {
    const token = extractTokenLike(value, [
        field,
        "token",
        "authToken",
        "csrfToken",
        "ssoKey",
        "ssoToken",
        "value",
    ]);
    if (!token) {
        throw new Error(`Expected a string token for ${field}, got: ${JSON.stringify(value)}`);
    }
    return token;
}

export interface LookupDumpFiles {
    dir: string;
    files: {
        metadata: string;
        accounts: string;
        categories: string;
        currencies: string;
        maps: string;
    };
}

/**
 * Writes debug lookup dumps as separate JSON files to reduce CLI noise.
 */
export function writeLookupDumpFiles(data: LookupData, maps: LookupMaps, userId: string): LookupDumpFiles {
    const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
    const dir = path.resolve("debug", `couch-lookups-${timestamp}`);
    fs.mkdirSync(dir, {recursive: true});

    const files = {
        metadata: path.join(dir, "metadata.json"),
        accounts: path.join(dir, "accounts.json"),
        categories: path.join(dir, "categories.json"),
        currencies: path.join(dir, "currencies.json"),
        maps: path.join(dir, "maps.json"),
    };

    const metadata = {
        generatedAt: new Date().toISOString(),
        userId,
        counts: {
            accounts: data.accounts.length,
            categories: data.categories.length,
            currencies: data.currencies.length,
        },
        transferCategoryId: maps.transferCategoryId,
    };

    fs.writeFileSync(files.metadata, JSON.stringify(metadata, null, 2), "utf8");
    fs.writeFileSync(files.accounts, JSON.stringify(data.accounts, null, 2), "utf8");
    fs.writeFileSync(files.categories, JSON.stringify(data.categories, null, 2), "utf8");
    fs.writeFileSync(files.currencies, JSON.stringify(data.currencies, null, 2), "utf8");
    fs.writeFileSync(files.maps, JSON.stringify(maps, null, 2), "utf8");

    return {dir, files};
}