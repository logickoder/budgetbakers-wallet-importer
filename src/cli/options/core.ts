import type { LogLevelName } from "../../logger.js";
import type { RunOptions } from "./types.js";

type OptionsParseErrorCode = "invalid" | "help";

export class OptionsParseError extends Error {
    code: OptionsParseErrorCode;

    constructor(message: string, code: OptionsParseErrorCode = "invalid") {
        super(message);
        this.name = "OptionsParseError";
        this.code = code;
    }
}

function parsePositiveInt(value: string): number | null {
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return null;
    return parsed;
}

function parseTimestamp(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) return null;

    return new Date(ms).toISOString();
}

function parseLogLevel(value: string): LogLevelName | null {
    const normalized = value.trim().toLowerCase();
    if (normalized === "info" || normalized === "warn" || normalized === "error") {
        return normalized;
    }
    return null;
}

function getInlineValue(arg: string): string {
    const parts = arg.split("=");
    return parts.slice(1).join("=").trim();
}

function requireValue(args: string[], index: number, flag: string): string {
    const value = args[index + 1] ?? "";
    if (!value.trim()) {
        throw new OptionsParseError(`Missing value for ${flag}.`);
    }
    return value;
}

function validateOptions(options: RunOptions): void {
    if (options.listLastRequested && options.rollbackLastRequested) {
        throw new OptionsParseError("Use either --list-last or --rollback-last, not both.");
    }

    const hasRecordRange = options.startTimestamp !== null || options.endTimestamp !== null;
    const hasListOrRollback = options.listLastRequested || options.rollbackLastRequested;
    if (hasRecordRange && !hasListOrRollback) {
        throw new OptionsParseError("--start-ts and --end-ts can only be used with --list-last or --rollback-last.");
    }

    if (
        options.startTimestamp
        && options.endTimestamp
        && Date.parse(options.startTimestamp) > Date.parse(options.endTimestamp)
    ) {
        throw new OptionsParseError("--start-ts cannot be later than --end-ts.");
    }

    if (options.listLastRequested && options.listLastRecords < 1) {
        throw new OptionsParseError("--list-last requires a positive integer count.");
    }

    if (options.rollbackLastRequested && options.rollbackLastRecords < 1) {
        throw new OptionsParseError("--rollback-last requires a positive integer count.");
    }
}

function parseCount(value: string, flag: "--list-last" | "--rollback-last"): number {
    const parsed = parsePositiveInt(value);
    if (!parsed) {
        throw new OptionsParseError(`Invalid ${flag}. Use a positive integer.`);
    }
    return parsed;
}

function parseIsoTimestamp(value: string, flag: "--start-ts" | "--end-ts"): string {
    const parsed = parseTimestamp(value);
    if (!parsed) {
        throw new OptionsParseError(`Invalid ${flag}. Use a valid date/time value.`);
    }
    return parsed;
}

export function parseRunOptionsOrThrow(args: string[]): RunOptions {
    const options: RunOptions = {
        debug: true,
        refreshCache: false,
        logLevel: "info",
        email: null,
        csvPath: null,
        yes: false,
        listLastRequested: false,
        rollbackLastRequested: false,
        listLastRecords: 0,
        rollbackLastRecords: 0,
        startTimestamp: null,
        endTimestamp: null,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--debug") options.debug = true;
        else if (arg === "--no-debug") options.debug = false;
        else if (arg === "--refresh-cache") options.refreshCache = true;
        else if (arg === "--yes" || arg === "-y") options.yes = true;
        else if (arg === "-h" || arg === "--help") throw new OptionsParseError("help", "help");
        else if (arg.startsWith("--list-last=")) {
            options.listLastRequested = true;
            options.listLastRecords = parseCount(getInlineValue(arg), "--list-last");
        } else if (arg === "--list-last") {
            options.listLastRequested = true;
            options.listLastRecords = parseCount(requireValue(args, i, "--list-last"), "--list-last");
            i += 1;
        } else if (arg.startsWith("--rollback-last=")) {
            options.rollbackLastRequested = true;
            options.rollbackLastRecords = parseCount(getInlineValue(arg), "--rollback-last");
        } else if (arg === "--rollback-last") {
            options.rollbackLastRequested = true;
            options.rollbackLastRecords = parseCount(requireValue(args, i, "--rollback-last"), "--rollback-last");
            i += 1;
        } else if (arg.startsWith("--start-ts=")) {
            options.startTimestamp = parseIsoTimestamp(getInlineValue(arg), "--start-ts");
        } else if (arg === "--start-ts") {
            options.startTimestamp = parseIsoTimestamp(requireValue(args, i, "--start-ts"), "--start-ts");
            i += 1;
        } else if (arg.startsWith("--end-ts=")) {
            options.endTimestamp = parseIsoTimestamp(getInlineValue(arg), "--end-ts");
        } else if (arg === "--end-ts") {
            options.endTimestamp = parseIsoTimestamp(requireValue(args, i, "--end-ts"), "--end-ts");
            i += 1;
        } else if (arg.startsWith("--log-level=")) {
            const parsed = parseLogLevel(getInlineValue(arg));
            if (!parsed) throw new OptionsParseError("Invalid --log-level. Use: info, warn, or error.");
            options.logLevel = parsed;
        } else if (arg === "--log-level") {
            const parsed = parseLogLevel(requireValue(args, i, "--log-level"));
            if (!parsed) throw new OptionsParseError("Invalid --log-level. Use: info, warn, or error.");
            options.logLevel = parsed;
            i += 1;
        } else if (arg.startsWith("--email=")) {
            options.email = getInlineValue(arg) || null;
        } else if (arg === "--email") {
            options.email = requireValue(args, i, "--email");
            i += 1;
        } else if (arg.startsWith("--csv=")) {
            options.csvPath = getInlineValue(arg) || null;
        } else if (arg === "--csv") {
            options.csvPath = requireValue(args, i, "--csv");
            i += 1;
        }
    }

    validateOptions(options);
    return options;
}
