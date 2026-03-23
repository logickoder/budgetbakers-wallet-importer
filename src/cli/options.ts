import type { LogLevelName } from "../logger.js";

export interface RunOptions {
    debug: boolean;
    refreshCache: boolean;
    logLevel: LogLevelName;
    email: string | null;
    csvPath: string | null;
    yes: boolean;
    listLastRequested: boolean;
    rollbackLastRequested: boolean;
    listLastRecords: number;
    rollbackLastRecords: number;
    startTimestamp: string | null;
    endTimestamp: string | null;
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

function printHelp(): void {
    console.log("Usage: budgetbakers-wallet-importer [flags]");
    console.log("  --debug                Enable verbose debug logs (default)");
    console.log("  --no-debug             Disable verbose debug logs");
    console.log("  --refresh-cache        Force fresh lookup fetch from CouchDB");
    console.log("  --log-level <level>    Minimum level written to logs (info|warn|error)");
    console.log("  --email <email>        Use this email (skip email selection prompt)");
    console.log("  --csv <path>           Use this CSV path (skip CSV path prompt)");
    console.log("  --list-last <count>    List the most recently created Record docs");
    console.log("  --rollback-last <count> Delete the most recently created Record docs");
    console.log("  --start-ts <iso>       Filter fetched last-N records by created time lower bound");
    console.log("  --end-ts <iso>         Filter fetched last-N records by created time upper bound");
    console.log("  --yes, -y              Auto-confirm record write prompt");
    console.log("  -h, --help             Show this help");
}

export function parseRunOptions(args: string[]): RunOptions {
    let debug = true;
    let refreshCache = false;
    let logLevel: LogLevelName = "info";
    let email: string | null = null;
    let csvPath: string | null = null;
    let yes = false;
    let listLastRequested = false;
    let rollbackLastRequested = false;
    let listLastRecords = 0;
    let rollbackLastRecords = 0;
    let startTimestamp: string | null = null;
    let endTimestamp: string | null = null;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--debug") debug = true;
        else if (arg === "--no-debug") debug = false;
        else if (arg === "--refresh-cache") refreshCache = true;
        else if (arg === "--yes" || arg === "-y") yes = true;
        else if (arg.startsWith("--list-last=")) {
            const raw = arg.split("=")[1] ?? "";
            listLastRequested = true;
            const parsed = parsePositiveInt(raw);
            if (!parsed) {
                console.error("Invalid --list-last. Use a positive integer.");
                process.exit(1);
            }
            listLastRecords = parsed;
        } else if (arg === "--list-last") {
            listLastRequested = true;
            const next = args[i + 1] ?? "";
            const parsed = parsePositiveInt(next);
            if (!parsed) {
                console.error("Invalid --list-last. Use a positive integer.");
                process.exit(1);
            }
            listLastRecords = parsed;
            i += 1;
        } else if (arg.startsWith("--rollback-last=")) {
            const raw = arg.split("=")[1] ?? "";
            rollbackLastRequested = true;
            const parsed = parsePositiveInt(raw);
            if (!parsed) {
                console.error("Invalid --rollback-last. Use a positive integer.");
                process.exit(1);
            }
            rollbackLastRecords = parsed;
        } else if (arg === "--rollback-last") {
            rollbackLastRequested = true;
            const next = args[i + 1] ?? "";
            const parsed = parsePositiveInt(next);
            if (!parsed) {
                console.error("Invalid --rollback-last. Use a positive integer.");
                process.exit(1);
            }
            rollbackLastRecords = parsed;
            i += 1;
        } else if (arg.startsWith("--start-ts=")) {
            const parsed = parseTimestamp(arg.split("=")[1] ?? "");
            if (!parsed) {
                console.error("Invalid --start-ts. Use a valid date/time value.");
                process.exit(1);
            }
            startTimestamp = parsed;
        } else if (arg === "--start-ts") {
            const parsed = parseTimestamp(args[i + 1] ?? "");
            if (!parsed) {
                console.error("Invalid --start-ts. Use a valid date/time value.");
                process.exit(1);
            }
            startTimestamp = parsed;
            i += 1;
        } else if (arg.startsWith("--end-ts=")) {
            const parsed = parseTimestamp(arg.split("=")[1] ?? "");
            if (!parsed) {
                console.error("Invalid --end-ts. Use a valid date/time value.");
                process.exit(1);
            }
            endTimestamp = parsed;
        } else if (arg === "--end-ts") {
            const parsed = parseTimestamp(args[i + 1] ?? "");
            if (!parsed) {
                console.error("Invalid --end-ts. Use a valid date/time value.");
                process.exit(1);
            }
            endTimestamp = parsed;
            i += 1;
        }
        else if (arg.startsWith("--log-level=")) {
            const parsed = parseLogLevel(arg.split("=")[1] ?? "");
            if (!parsed) {
                console.error("Invalid --log-level. Use: info, warn, or error.");
                process.exit(1);
            }
            logLevel = parsed;
        } else if (arg === "--log-level") {
            const parsed = parseLogLevel(args[i + 1] ?? "");
            if (!parsed) {
                console.error("Invalid --log-level. Use: info, warn, or error.");
                process.exit(1);
            }
            logLevel = parsed;
            i += 1;
        } else if (arg.startsWith("--email=")) {
            email = arg.split("=")[1] ?? null;
        } else if (arg === "--email") {
            email = args[i + 1] ?? null;
            i += 1;
        } else if (arg.startsWith("--csv=")) {
            csvPath = arg.split("=")[1] ?? null;
        } else if (arg === "--csv") {
            csvPath = args[i + 1] ?? null;
            i += 1;
        } else if (arg === "-h" || arg === "--help") {
            printHelp();
            process.exit(0);
        }
    }

    if (listLastRequested && rollbackLastRequested) {
        console.error("Use either --list-last or --rollback-last, not both.");
        process.exit(1);
    }

    const hasRecordRange = startTimestamp !== null || endTimestamp !== null;
    const hasListOrRollback = listLastRequested || rollbackLastRequested;

    if (hasRecordRange && !hasListOrRollback) {
        console.error("--start-ts and --end-ts can only be used with --list-last or --rollback-last.");
        process.exit(1);
    }

    if (startTimestamp && endTimestamp && Date.parse(startTimestamp) > Date.parse(endTimestamp)) {
        console.error("--start-ts cannot be later than --end-ts.");
        process.exit(1);
    }

    if (listLastRequested && listLastRecords < 1) {
        console.error("--list-last requires a positive integer count.");
        process.exit(1);
    }

    if (rollbackLastRequested && rollbackLastRecords < 1) {
        console.error("--rollback-last requires a positive integer count.");
        process.exit(1);
    }

    return {
        debug,
        refreshCache,
        logLevel,
        email,
        csvPath,
        yes,
        listLastRequested,
        rollbackLastRequested,
        listLastRecords,
        rollbackLastRecords,
        startTimestamp,
        endTimestamp,
    };
}
