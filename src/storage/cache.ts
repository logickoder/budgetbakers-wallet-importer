import fs from "fs";
import path from "path";

import type {
    LookupCacheMetadata,
    LookupCacheSnapshot,
    LookupData,
    LookupMaps,
} from "../types.js";
import { emailToUserKey, normalizeEmail, userLookupFiles } from "./paths.js";

function readJsonFile<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJsonFile(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

export function writeLookupCache(email: string, userId: string, data: LookupData, maps: LookupMaps): LookupCacheSnapshot {
    const normalizedEmail = normalizeEmail(email);
    const userKey = emailToUserKey(normalizedEmail);
    const files = userLookupFiles(normalizedEmail);

    const metadata: LookupCacheMetadata = {
        version: 1,
        source: "couch",
        generatedAt: new Date().toISOString(),
        email: normalizedEmail,
        userKey,
        userId,
        counts: {
            accounts: data.accounts.length,
            categories: data.categories.length,
            currencies: data.currencies.length,
        },
        transferCategoryId: maps.transferCategoryId,
    };

    writeJsonFile(files.accounts, data.accounts);
    writeJsonFile(files.categories, data.categories);
    writeJsonFile(files.currencies, data.currencies);
    writeJsonFile(files.maps, maps);
    writeJsonFile(files.metadata, metadata);

    return { data, maps, metadata };
}

export function loadLookupCache(email: string): LookupCacheSnapshot | null {
    const normalizedEmail = normalizeEmail(email);
    const files = userLookupFiles(normalizedEmail);
    const requiredFiles = [files.metadata, files.accounts, files.categories, files.currencies, files.maps];

    for (const filePath of requiredFiles) {
        if (!fs.existsSync(filePath)) return null;
    }

    try {
        const metadata = readJsonFile<LookupCacheMetadata>(files.metadata);
        const accounts = readJsonFile<LookupData["accounts"]>(files.accounts);
        const categories = readJsonFile<LookupData["categories"]>(files.categories);
        const currencies = readJsonFile<LookupData["currencies"]>(files.currencies);
        const maps = readJsonFile<LookupMaps>(files.maps);

        if (metadata.version !== 1) return null;
        if (normalizeEmail(metadata.email) !== normalizedEmail) return null;

        return {
            metadata: {
                ...metadata,
                source: "cache",
            },
            data: { accounts, categories, currencies },
            maps,
        };
    } catch {
        return null;
    }
}
