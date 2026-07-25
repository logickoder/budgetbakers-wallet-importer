import type { LogLevelName } from "../../logger.js";

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
    rollbackImportRequested: boolean;
    rollbackImportId: string | null;
    batchId: string | null;
    dryRun: boolean;
    /** Path to a bankstract export (JSON/CSV) used as the import source. */
    fromBankstract: string | null;
    /** Bank id override for bankstract input (required for CSV, which has no bank column). */
    bankstractBank: string | null;
    /** Path to a bank→account map JSON: `{ "fbn": "First Bank" }`. */
    bankMapPath: string | null;
    /** Default category applied to every bankstract row. */
    defaultCategory: string | null;
    /** Convert bankstract input to importer CSV and exit (no CouchDB write). */
    convertOnly: boolean;
    /** Output path for `--convert-only`; null → derived from the input name. */
    convertOnlyPath: string | null;
}
