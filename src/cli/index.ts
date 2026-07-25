#!/usr/bin/env node
/**
 * @file cli/index.ts
 * @description Interactive terminal importer for BudgetBakers with optional debug logging.
 */

import fs from "fs";
import path from "path";

import { clearAuthCookies, login } from "../auth.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "../couch.js";
import type { CsvRow, SkippedRow } from "../csv.js";
import { convertRows, isTransferCategoryAlias, parseCsv, rowsToCsv, skippedRowsToCsv } from "../csv.js";
import { bankstractToCsvRows, loadBankMap, readBankstractInput } from "../bankstract.js";
import type { LookupMaps } from "../types.js";
import type { RunOptions } from "./options/types.js";
import { createLogger } from "../logger.js";
import { makeImportBatchId, writeRecords } from "../records.js";
import type { UserSession } from "../types.js";
import {
    loadLookupCache,
    loadSessionIndex,
    loadUserSession,
    pruneUserDebugDumps,
    pruneUserLogs,
    removeUserSession,
    saveUserSession,
    userDataDir,
    writeLookupCache,
    writeLookupDumpFiles,
} from "../storage/index.js";
import { ask, selectEmail } from "./interaction.js";
import { runMaintenanceMode } from "./maintenance.js";
import { parseRunOptions } from "./options/index.js";
import { buildImportPreview, printImportPreview } from "./preview.js";
import { makeRunId, outputPaths, resolveLookupData } from "./run.js";

/**
 * Derives the default `--convert-only` output path: `<input>.imported.csv`
 * next to the source file.
 */
function defaultConvertOutPath(inputPath: string): string {
    const dir = path.dirname(inputPath);
    const base = path.basename(inputPath, path.extname(inputPath));
    return path.join(dir, `${base}.imported.csv`);
}

/**
 * Loads a bankstract export (JSON/CSV) and maps it to importer rows. Shared by
 * the convert-only and direct-import paths so the two never drift.
 */
function loadBankstractRows(options: RunOptions, resolvedPath: string): { rows: CsvRow[]; bank: string | null } {
    const bankMap = options.bankMapPath ? loadBankMap(path.resolve(options.bankMapPath)) : {};
    const input = readBankstractInput(resolvedPath, options.bankstractBank);
    const rows = bankstractToCsvRows(input, bankMap, options.defaultCategory ?? "");
    return { rows, bank: input.bank };
}

/**
 * Warns about bankstract rows that will fail on a blank account or category.
 * Applies to both paths: in convert-only the user fills the column, in direct
 * import the row lands in the failure CSV.
 */
function warnBankstractGaps(rows: CsvRow[]): void {
    let missingAccount = 0;
    let missingCategory = 0;
    for (const r of rows) {
        if (!r.account.trim()) missingAccount++;
        if (!r.category.trim()) missingCategory++;
    }
    if (missingAccount > 0) {
        console.log(`  ⚠ ${missingAccount} row(s) have no account. Set --bank-map, or fill the 'account' column before importing.`);
    }
    if (missingCategory > 0) {
        console.log(`  ⚠ ${missingCategory} row(s) have no category. Set --default-category, or fill the 'category' column before importing.`);
    }
}

/**
 * Warns when the bankstract `--default-category` resolves to the transfer
 * category. convertRows would then treat every row as a transfer leg and pair
 * rows that share a timestamp, corrupting the import.
 */
function warnTransferDefaultCategory(defaultCategory: string | null, maps: LookupMaps): void {
    const category = defaultCategory?.trim();
    if (!category) return;
    const resolvesToTransfer =
        (maps.transferCategoryId !== null && maps.categories[category] === maps.transferCategoryId) ||
        isTransferCategoryAlias(category);
    if (resolvesToTransfer) {
        console.log(
            `  ⚠ --default-category "${category}" is the transfer category. Rows sharing a timestamp will be ` +
            "mis-linked as transfers. Use a non-transfer default, or --convert-only to categorise per row."
        );
    }
}

/**
 * Converts a bankstract export to importer-format CSV and exits. No CouchDB
 * login or lookup is needed. This path only reshapes the file so the user can
 * review/edit it (in Excel) before a normal `--csv` import.
 */
function runBankstractConvert(options: RunOptions): never {
    const inputPath = path.resolve(options.fromBankstract as string);
    if (!fs.existsSync(inputPath)) {
        console.error(`File not found: ${inputPath}`);
        process.exit(1);
    }

    const { rows, bank } = loadBankstractRows(options, inputPath);

    const outPath = options.convertOnlyPath
        ? path.resolve(options.convertOnlyPath)
        : defaultConvertOutPath(inputPath);
    fs.writeFileSync(outPath, rowsToCsv(rows), "utf8");

    console.log(`Converted ${rows.length} transaction(s) → ${outPath}`);
    if (bank) console.log(`  Bank: ${bank}`);
    warnBankstractGaps(rows);
    console.log(`\nEdit the file, then import with:\n  budgetbakers-wallet-importer --csv "${outPath}"`);

    process.exit(0);
}

async function main() {
    const options = parseRunOptions(process.argv.slice(2));
    const runId = makeRunId();

    console.log("\n── BudgetBakers CSV Importer ──\n");

    if (options.convertOnly) {
        runBankstractConvert(options);
    }

    let sessionIndex = loadSessionIndex();
    const email = await selectEmail(sessionIndex, options.email);
    const logFilePath = path.join(userDataDir(email), "logs", `importer-${runId}.log`);
    const log = createLogger(options.debug, logFilePath, options.logLevel);

    const logRotation = pruneUserLogs(email, 40);
    const dumpRotation = pruneUserDebugDumps(email, 20);
    log("Run options", options);
    log("Log file initialized", { logFilePath });
    log("Log rotation completed", logRotation);
    log("Debug dump rotation completed", dumpRotation);

    const indexedSession = sessionIndex.users[email];
    const fallbackSession: UserSession | null = indexedSession
        ? {
            email,
            sessionToken: indexedSession.sessionToken,
            userId: indexedSession.userId,
            savedAt: indexedSession.savedAt,
        }
        : null;
    const savedSession = loadUserSession(email) ?? fallbackSession;

    if (savedSession) {
        console.log(`Found saved session for ${email}. Skipping SSO.\n`);
    }
    log("Session state", {
        hasSavedToken: Boolean(savedSession),
        selectedEmail: email,
        knownUsers: Object.keys(sessionIndex.users).length,
    });

    let loginResult;
    try {
        loginResult = await login(email, savedSession?.sessionToken ?? null, log);
    } catch (error) {
        log.error("Initial login attempt failed", {
            error: error instanceof Error ? error.message : String(error),
        });

        if (savedSession) {
            console.log("Session expired. Starting fresh SSO flow.\n");
            sessionIndex = removeUserSession(sessionIndex, email);
            await clearAuthCookies();
            log("Auth cookie jar cleared before fresh SSO retry");
            loginResult = await login(email, null, log);
        } else {
            throw new Error("Login failed", { cause: error });
        }
    }

    sessionIndex = saveUserSession(sessionIndex, email, loginResult.sessionToken, loginResult.userId);
    log("Login succeeded", {
        userId: loginResult.userId,
        hasReplicationToken: Boolean(loginResult.replication?.token),
    });
    console.log(`\nLogged in as ${email}\n`);

    if (options.refreshCache) {
        console.log("Refreshing lookup cache from CouchDB...");
    } else {
        console.log("Loading lookup data (cache-first)...");
    }

    const couch = buildCouchClient(loginResult.replication);
    log("CouchDB client initialized", {
        dbName: loginResult.replication.dbName,
        baseUrl: loginResult.replication.url,
    });

    const maintenanceExitCode = await runMaintenanceMode({
        couch,
        options,
        ask,
        log,
    });
    if (maintenanceExitCode !== null) {
        process.exit(maintenanceExitCode);
    }

    const lookup = await resolveLookupData({
        email,
        userId: loginResult.userId,
        refreshCache: options.refreshCache,
        loadCache: loadLookupCache,
        fetchLookupData: async () => fetchLookupData(couch),
        buildLookupMaps: buildLookupMapsFromData,
        persistCache: writeLookupCache,
        log,
    });

    log("Lookup maps loaded", {
        source: lookup.source,
        durationMs: lookup.durationMs,
        accounts: Object.keys(lookup.maps.accounts).length,
        categories: Object.keys(lookup.maps.categories).length,
        currencies: Object.keys(lookup.maps.currencies).length,
    });

    if (lookup.source === "cache") {
        console.log(`Lookup cache hit → ${userDataDir(email)}\n`);
    }

    if (options.debug) {
        try {
            const dump = writeLookupDumpFiles(email, lookup.lookupData, lookup.maps, loginResult.userId);
            console.log(`Debug lookup dumps → ${dump.dir}`);
            log("Lookup debug dumps written", { dump });
        } catch (error) {
            console.error(
                "Warning: failed to write debug lookup dumps:",
                error instanceof Error ? error.message : String(error)
            );
            log.warn("Lookup debug dumps failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    console.log(
        `  ${Object.keys(lookup.maps.accounts).length} accounts  ·  ` +
        `${Object.keys(lookup.maps.categories).length} categories  ·  ` +
        `${Object.keys(lookup.maps.currencies).length} currencies\n`
    );

    let resolved: string;
    let rows: CsvRow[];

    if (options.fromBankstract) {
        resolved = path.resolve(options.fromBankstract);
        log("bankstract input resolved", { input: options.fromBankstract, resolved });
        if (!fs.existsSync(resolved)) {
            console.error(`File not found: ${resolved}`);
            process.exit(1);
        }

        console.log("\nReading bankstract export...");
        const loaded = loadBankstractRows(options, resolved);
        rows = loaded.rows;
        log("bankstract input parsed", { bank: loaded.bank, transactions: rows.length });

        warnBankstractGaps(rows);
        warnTransferDefaultCategory(options.defaultCategory, lookup.maps);
    } else {
        console.log("Expected CSV format:");
        console.log("  date,account,amount,category,note,payee");
        console.log("  2026-01-27 02:31:00,First Bank,-53.75,Charges & Fees,Stamp Duty,");
        console.log("  (account names must match exactly; category is exact except transfer aliases like TRANSFER)\n");

        const csvInput = options.csvPath ?? await ask("Path to CSV file: ");
        resolved = path.resolve(csvInput);
        log("CSV path resolved", { input: csvInput, resolved });

        if (!fs.existsSync(resolved)) {
            console.error(`File not found: ${resolved}`);
            process.exit(1);
        }

        console.log("\nParsing CSV...");
        const raw = fs.readFileSync(resolved, "utf8");
        rows = parseCsv(raw);
    }

    const { success: successPath, failure: failurePath } = outputPaths(resolved);
    const { records, originalRows, skipped } = convertRows(rows, lookup.maps);
    log("CSV parsed", {
        rows: rows.length,
        records: records.length,
        skipped: skipped.length,
    });

    const dataRowCount = rows.filter((r) => r.date?.trim()).length;

    console.log(`\n  Total rows:         ${dataRowCount}`);
    console.log(`  Ready to import:    ${records.length}`);
    console.log(`  Skipped (bad data): ${skipped.length}`);

    if (skipped.length > 0) {
        const byReason = new Map<string, number>();
        for (const { reason } of skipped) {
            byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
        }
        console.log("\n  Skipped reasons:");
        for (const [reason, count] of byReason) {
            console.log(`    [${count}×] ${reason}`);
        }
    }

    if (records.length === 0) {
        console.log("\nNothing to import.");
        if (skipped.length > 0) {
            fs.writeFileSync(failurePath, skippedRowsToCsv(skipped), "utf8");
            console.log(`Failure CSV written → ${failurePath}`);
        }
        process.exit(0);
    }

    const preview = buildImportPreview(records, lookup.maps);
    printImportPreview(preview);

    const batchId = options.batchId ?? makeImportBatchId();
    console.log(`\nImport batch id: ${batchId}`);
    if (options.batchId) {
        console.log("  (reusing supplied batch id. Duplicate rows will be skipped)");
    }
    log("Import batch id", { batchId, reused: Boolean(options.batchId) });

    if (options.dryRun) {
        console.log("\nDry run. No records written.");
        if (skipped.length > 0) {
            fs.writeFileSync(failurePath, skippedRowsToCsv(skipped), "utf8");
            console.log(`Failure CSV → ${failurePath}`);
        }
        log("Dry run complete", { records: records.length, skipped: skipped.length });
        process.exit(0);
    }

    if (!options.yes) {
        console.log();
        const confirm = await ask(`Write ${records.length} records to BudgetBakers? [y/N] `);
        log("Write confirmation answer", { answer: confirm });
        if (confirm.toLowerCase() !== "y") {
            console.log("Aborted.");
            process.exit(0);
        }
    } else {
        log("Write confirmation bypassed via --yes");
    }

    console.log("\nWriting records...");
    log("CouchDB bulk write started", { recordCount: records.length, batchId });
    const writeStart = Date.now();
    const writeOutcome = await writeRecords(couch, loginResult.userId, records, batchId);
    log("Bulk write completed", {
        results: writeOutcome.results.length,
        successCount: writeOutcome.successCount,
        duplicateCount: writeOutcome.duplicateCount,
        durationMs: Date.now() - writeStart,
    });

    const successRows: CsvRow[] = [];
    const duplicateRows: CsvRow[] = [];
    const writeFailures: SkippedRow[] = [];

    for (let i = 0; i < writeOutcome.results.length; i++) {
        const result = writeOutcome.results[i];
        if (result.ok) {
            successRows.push(originalRows[i]);
        } else if (result.error === "conflict") {
            duplicateRows.push(originalRows[i]);
        } else {
            writeFailures.push({
                row: originalRows[i],
                reason: `CouchDB rejected: ${result.error}. ${result.reason}`,
            });
        }
    }

    log("Write split summary", {
        success: successRows.length,
        duplicates: duplicateRows.length,
        writeFailures: writeFailures.length,
    });

    if (writeFailures.length > 0) {
        log.warn("CouchDB reported write failures", {
            count: writeFailures.length,
            failures: writeFailures.slice(0, 10),
        });
    }

    const allFailures: SkippedRow[] = [...skipped, ...writeFailures];

    fs.writeFileSync(successPath, rowsToCsv(successRows), "utf8");
    fs.writeFileSync(failurePath, skippedRowsToCsv(allFailures), "utf8");
    log("Output files written", { successPath, failurePath });

    console.log();
    console.log(`✓ ${successRows.length} records written successfully`);
    if (duplicateRows.length > 0) {
        console.log(`↻ ${duplicateRows.length} duplicate(s) skipped (already in batch ${batchId})`);
    }

    if (allFailures.length > 0) {
        console.log(`✗ ${allFailures.length} rows failed`);
        console.log(`  (${skipped.length} bad data, ${writeFailures.length} CouchDB rejections)`);
    }

    console.log();
    console.log(`Success CSV → ${successPath}`);
    console.log(`Failure CSV → ${failurePath}`);
    console.log(`Run log → ${logFilePath}`);
    console.log(`Rollback this batch: --rollback-import ${batchId}`);
    log("Run completed", {
        successRows: successRows.length,
        duplicateRows: duplicateRows.length,
        failureRows: allFailures.length,
        batchId,
        logFilePath,
    });

    if (writeFailures.length > 0) process.exit(1);
}

main().catch((err) => {
    console.error("\nFatal error:", err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) {
        console.error(err.stack);
    }
    if (err instanceof Error && err.cause) console.error("Caused by:", err.cause);
    process.exit(1);
});
