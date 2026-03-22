import { createHash } from "crypto";
import fs from "fs";
import path from "path";

import type {
    LookupCacheFiles,
    LookupCacheMetadata,
    LookupCacheSnapshot,
    LookupData,
    LookupMaps,
    SessionIndex,
    SessionIndexUser,
    UserSession,
} from "./types.js";

const SESSION_INDEX_FILE = ".budgetbakers-session.json";
const DATA_ROOT_DIR = "data";

function readJsonFile<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJsonFile(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

export function normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
}

export function emailToUserKey(email: string): string {
    return createHash("sha256").update(normalizeEmail(email)).digest("hex").slice(0, 24);
}

function sessionIndexPath(): string {
    return path.resolve(SESSION_INDEX_FILE);
}

export function userDataDir(email: string): string {
    return path.resolve(DATA_ROOT_DIR, emailToUserKey(email));
}

export function userLogDir(email: string): string {
    return path.join(userDataDir(email), "logs");
}

function userSessionPath(email: string): string {
    return path.join(userDataDir(email), "session.json");
}

function userLookupFiles(email: string): LookupCacheFiles {
    const dir = userDataDir(email);
    return {
        metadata: path.join(dir, "metadata.json"),
        accounts: path.join(dir, "accounts.json"),
        categories: path.join(dir, "categories.json"),
        currencies: path.join(dir, "currencies.json"),
        maps: path.join(dir, "maps.json"),
    };
}

function isValidSessionIndex(value: unknown): value is SessionIndex {
    if (!value || typeof value !== "object") return false;
    const obj = value as Record<string, unknown>;
    return obj.version === 1 && hasOwn(obj, "users") && typeof obj.users === "object";
}

function emptySessionIndex(): SessionIndex {
    return { version: 1, lastUsedEmail: null, users: {} };
}

export function loadSessionIndex(): SessionIndex {
    const filePath = sessionIndexPath();
    if (!fs.existsSync(filePath)) return emptySessionIndex();

    try {
        const parsed = readJsonFile<unknown>(filePath);
        if (!isValidSessionIndex(parsed)) return emptySessionIndex();
        return parsed;
    } catch {
        return emptySessionIndex();
    }
}

export function saveSessionIndex(index: SessionIndex): void {
    writeJsonFile(sessionIndexPath(), index);
}

export function listSavedEmails(index: SessionIndex): string[] {
    const emails = Object.keys(index.users);
    if (index.lastUsedEmail && emails.includes(index.lastUsedEmail)) {
        return [index.lastUsedEmail, ...emails.filter((e) => e !== index.lastUsedEmail)];
    }
    return emails.sort((a, b) => a.localeCompare(b));
}

function safeSessionIndexUser(email: string, session: UserSession): SessionIndexUser {
    return {
        userKey: emailToUserKey(email),
        sessionFile: userSessionPath(email),
        sessionToken: session.sessionToken,
        userId: session.userId,
        savedAt: session.savedAt,
    };
}

export function loadUserSession(email: string): UserSession | null {
    const filePath = userSessionPath(email);
    if (!fs.existsSync(filePath)) return null;

    try {
        const parsed = readJsonFile<unknown>(filePath);
        if (!parsed || typeof parsed !== "object") return null;
        const obj = parsed as Record<string, unknown>;
        const { email: parsedEmail, sessionToken, userId, savedAt } = obj;
        if (typeof parsedEmail !== "string") return null;
        if (typeof sessionToken !== "string") return null;
        if (typeof userId !== "string") return null;
        if (typeof savedAt !== "string") return null;
        return {
            email: parsedEmail,
            sessionToken,
            userId,
            savedAt,
        };
    } catch {
        return null;
    }
}

export function saveUserSession(index: SessionIndex, email: string, sessionToken: string, userId: string): SessionIndex {
    const normalizedEmail = normalizeEmail(email);
    const session: UserSession = {
        email: normalizedEmail,
        sessionToken,
        userId,
        savedAt: new Date().toISOString(),
    };

    writeJsonFile(userSessionPath(normalizedEmail), session);

    const updated: SessionIndex = {
        ...index,
        lastUsedEmail: normalizedEmail,
        users: {
            ...index.users,
            [normalizedEmail]: safeSessionIndexUser(normalizedEmail, session),
        },
    };

    saveSessionIndex(updated);
    return updated;
}

export function removeUserSession(index: SessionIndex, email: string): SessionIndex {
    const normalizedEmail = normalizeEmail(email);
    const updatedUsers = { ...index.users };
    delete updatedUsers[normalizedEmail];

    const sessionFile = userSessionPath(normalizedEmail);
    if (fs.existsSync(sessionFile)) {
        fs.unlinkSync(sessionFile);
    }

    const updated: SessionIndex = {
        ...index,
        users: updatedUsers,
        lastUsedEmail: index.lastUsedEmail === normalizedEmail ? null : index.lastUsedEmail,
    };

    saveSessionIndex(updated);
    return updated;
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
export function writeLookupDumpFiles(email: string, data: LookupData, maps: LookupMaps, userId: string): LookupDumpFiles {
    const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
    const dir = path.join(userDataDir(email), "debug", `couch-lookups-${timestamp}`);
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