import fs from "fs";
import path from "path";

import type { LookupData, LookupMaps } from "../types.js";
import { emailToUserKey, normalizeEmail, userDebugDir, userLogDir } from "./paths.js";

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
export function writeLookupDumpFiles(email: string, data: LookupData, maps: LookupMaps, userId: string): LookupDumpFiles {
    const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
    const dir = path.join(userDebugDir(email), `couch-lookups-${timestamp}`);
    fs.mkdirSync(dir, { recursive: true });

    const files = {
        metadata: path.join(dir, "metadata.json"),
        accounts: path.join(dir, "accounts.json"),
        categories: path.join(dir, "categories.json"),
        currencies: path.join(dir, "currencies.json"),
        maps: path.join(dir, "maps.json"),
    };

    const metadata = {
        generatedAt: new Date().toISOString(),
        email: normalizeEmail(email),
        userKey: emailToUserKey(email),
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

    return { dir, files };
}

export function pruneUserLogs(email: string, keepNewest: number): { removed: number; kept: number; dir: string } {
    const dir = userLogDir(email);
    if (!fs.existsSync(dir)) {
        return { removed: 0, kept: 0, dir };
    }

    const entries = fs.readdirSync(dir)
        .filter((name) => name.endsWith(".log"))
        .map((name) => {
            const fullPath = path.join(dir, name);
            const stat = fs.statSync(fullPath);
            return { fullPath, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const stale = entries.slice(Math.max(0, keepNewest));
    for (const item of stale) {
        fs.unlinkSync(item.fullPath);
    }

    return {
        removed: stale.length,
        kept: Math.min(entries.length, keepNewest),
        dir,
    };
}

export function pruneUserDebugDumps(email: string, keepNewest: number): { removed: number; kept: number; dir: string } {
    const dir = userDebugDir(email);
    if (!fs.existsSync(dir)) {
        return { removed: 0, kept: 0, dir };
    }

    const entries = fs.readdirSync(dir)
        .filter((name) => name.startsWith("couch-lookups-"))
        .map((name) => {
            const fullPath = path.join(dir, name);
            const stat = fs.statSync(fullPath);
            return { fullPath, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const stale = entries.slice(Math.max(0, keepNewest));
    for (const item of stale) {
        fs.rmSync(item.fullPath, { recursive: true, force: true });
    }

    return {
        removed: stale.length,
        kept: Math.min(entries.length, keepNewest),
        dir,
    };
}
