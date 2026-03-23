import {OptionsParseError, parseRunOptionsOrThrow} from "./core.js";
import type {RunOptions} from "./types.js";

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
    try {
        return parseRunOptionsOrThrow(args);
    } catch (error) {
        if (error instanceof OptionsParseError && error.code === "help") {
            printHelp();
            process.exit(0);
        }

        const message = error instanceof OptionsParseError
            ? error.message
            : "Invalid command-line arguments.";
        console.error(message);
        process.exit(1);
    }
}
