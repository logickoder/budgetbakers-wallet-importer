import { createHash } from "crypto";
import path from "path";

import type { LookupCacheFiles } from "../types.js";

export const SESSION_INDEX_FILE = ".budgetbakers-session.json";
const DATA_ROOT_DIR = "data";

export function normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
}

export function emailToUserKey(email: string): string {
    return createHash("sha256").update(normalizeEmail(email)).digest("hex").slice(0, 24);
}

export function sessionIndexPath(): string {
    return path.resolve(SESSION_INDEX_FILE);
}

export function userDataDir(email: string): string {
    return path.resolve(DATA_ROOT_DIR, emailToUserKey(email));
}

export function userLogDir(email: string): string {
    return path.join(userDataDir(email), "logs");
}

export function userSessionPath(email: string): string {
    return path.join(userDataDir(email), "session.json");
}

export function userLookupFiles(email: string): LookupCacheFiles {
    const dir = userDataDir(email);
    return {
        metadata: path.join(dir, "metadata.json"),
        accounts: path.join(dir, "accounts.json"),
        categories: path.join(dir, "categories.json"),
        currencies: path.join(dir, "currencies.json"),
        maps: path.join(dir, "maps.json"),
    };
}

export function userDebugDir(email: string): string {
    return path.join(userDataDir(email), "debug");
}
