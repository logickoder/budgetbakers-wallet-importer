import fs from "fs";
import path from "path";

import type { SessionIndex, SessionIndexUser, UserSession } from "../types.js";
import { emailToUserKey, normalizeEmail, sessionIndexPath, userSessionPath } from "./paths.js";

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

function isValidSessionIndex(value: unknown): value is SessionIndex {
    if (!value || typeof value !== "object") return false;
    const obj = value as Record<string, unknown>;
    return obj.version === 1 && hasOwn(obj, "users") && typeof obj.users === "object";
}

function emptySessionIndex(): SessionIndex {
    return { version: 1, lastUsedEmail: null, users: {} };
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
