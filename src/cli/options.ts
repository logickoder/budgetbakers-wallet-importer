import type { LogLevelName } from "../logger.js";

export interface RunOptions {
    debug: boolean;
    refreshCache: boolean;
    logLevel: LogLevelName;
    email: string | null;
    csvPath: string | null;
    yes: boolean;
}

function parseLogLevel(value: string): LogLevelName | null {
    const normalized = value.trim().toLowerCase();
    if (normalized === "info" || normalized === "warn" || normalized === "error") {
        return normalized;
    }
    return null;
}

function printHelp(): void {
    console.log("Usage: budgetbakers-importer [flags]");
    console.log("  --debug                Enable verbose debug logs (default)");
    console.log("  --no-debug             Disable verbose debug logs");
    console.log("  --refresh-cache        Force fresh lookup fetch from CouchDB");
    console.log("  --log-level <level>    Minimum level written to logs (info|warn|error)");
    console.log("  --email <email>        Use this email (skip email selection prompt)");
    console.log("  --csv <path>           Use this CSV path (skip CSV path prompt)");
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

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--debug") debug = true;
        else if (arg === "--no-debug") debug = false;
        else if (arg === "--refresh-cache") refreshCache = true;
        else if (arg === "--yes" || arg === "-y") yes = true;
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

    return { debug, refreshCache, logLevel, email, csvPath, yes };
}
