import fs from "fs";
import path from "path";

type LogLevel = "INFO" | "WARN" | "ERROR";
export type LogLevelName = "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
    INFO: 10,
    WARN: 20,
    ERROR: 30,
};

const SENSITIVE_KEYS = [
    "token",
    "sessiontoken",
    "authorization",
    "cookie",
    "password",
    "secret",
    "apikey",
    "auth",
];

export interface Logger {
    (message: string, details?: unknown): void;
    warn: (message: string, details?: unknown) => void;
    error: (message: string, details?: unknown) => void;
    logFilePath: string;
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(redactSensitive(value));
    } catch {
        return "[unserializable-details]";
    }
}

function shouldRedactKey(key: string): boolean {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    return SENSITIVE_KEYS.some((s) => normalized.includes(s));
}

function redactString(value: string): string {
    if (/^bearer\s+/i.test(value)) return "[REDACTED_BEARER_TOKEN]";
    if (/^basic\s+/i.test(value)) return "[REDACTED_BASIC_AUTH]";
    if (value.length >= 24 && /^[a-z0-9._-]+$/i.test(value)) return "[REDACTED_TOKEN_LIKE]";
    return value;
}

function redactSensitive(value: unknown): unknown {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map((v) => redactSensitive(v));
    if (!value || typeof value !== "object") return value;

    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input)) {
        if (shouldRedactKey(key)) {
            output[key] = "[REDACTED]";
        } else {
            output[key] = redactSensitive(val);
        }
    }
    return output;
}

function formatLine(level: LogLevel, message: string, details?: unknown): string {
    const timestamp = new Date().toISOString();
    if (details === undefined) {
        return `[budgetbakers-wallet-importer ${timestamp}] [${level}] ${message}`;
    }
    return `[budgetbakers-wallet-importer ${timestamp}] [${level}] ${message} ${safeStringify(details)}`;
}

function writeLine(filePath: string, line: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${line}\n`, "utf8");
}

function toLevel(name: LogLevelName): LogLevel {
    if (name === "warn") return "WARN";
    if (name === "error") return "ERROR";
    return "INFO";
}

function isAllowed(level: LogLevel, minimum: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[minimum];
}

export function createLogger(consoleEnabled: boolean, logFilePath: string, minimumLevelName: LogLevelName = "info"): Logger {
    const minimumLevel = toLevel(minimumLevelName);

    const log = ((message: string, details?: unknown): void => {
        const line = formatLine("INFO", message, details);
        if (!isAllowed("INFO", minimumLevel)) return;
        writeLine(logFilePath, line);
        if (consoleEnabled) console.log(line);
    }) as Logger;

    log.warn = (message: string, details?: unknown): void => {
        const line = formatLine("WARN", message, details);
        if (!isAllowed("WARN", minimumLevel)) return;
        writeLine(logFilePath, line);
        if (consoleEnabled) console.warn(line);
    };

    log.error = (message: string, details?: unknown): void => {
        const line = formatLine("ERROR", message, details);
        if (!isAllowed("ERROR", minimumLevel)) return;
        writeLine(logFilePath, line);
        if (consoleEnabled) console.error(line);
    };

    log.logFilePath = logFilePath;
    return log;
}