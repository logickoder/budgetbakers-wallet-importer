#!/usr/bin/env node
/**
 * @file cli/index.ts
 * @description Interactive terminal importer for BudgetBakers with optional debug logging.
 */

import fs from "fs";
import path from "path";

import { login } from "../auth.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "../couch.js";
import type { CsvRow, SkippedRow } from "../csv.js";
import { convertRows, parseCsv, rowsToCsv, skippedRowsToCsv } from "../csv.js";
import { createLogger } from "../logger.js";
import { writeRecords } from "../records.js";
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
import { makeRunId, outputPaths, resolveLookupData } from "./run.js";

async function main() {
    const options = parseRunOptions(process.argv.slice(2));
    const runId = makeRunId();

    console.log("\n── BudgetBakers CSV Importer ──\n");

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
        console.log(`Found saved session for ${email} — skipping SSO.\n`);
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
            console.log("Session expired — starting fresh SSO flow.\n");
            sessionIndex = removeUserSession(sessionIndex, email);
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

    console.log("Expected CSV format:");
    console.log("  date,account,amount,category,note,payee");
    console.log("  2026-01-27 02:31:00,First Bank,-53.75,Charges & Fees,Stamp Duty,");
    console.log("  (account names must match exactly; category is exact except transfer aliases like TRANSFER)\n");

    const csvInput = options.csvPath ?? await ask("Path to CSV file: ");
    const resolved = path.resolve(csvInput);
    log("CSV path resolved", { input: csvInput, resolved });

    if (!fs.existsSync(resolved)) {
        console.error(`File not found: ${resolved}`);
        process.exit(1);
    }

    const { success: successPath, failure: failurePath } = outputPaths(resolved);

    console.log("\nParsing CSV...");
    const raw = fs.readFileSync(resolved, "utf8");
    const rows = parseCsv(raw);
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
    log("CouchDB bulk write started", { recordCount: records.length });
    const writeStart = Date.now();
    const results = await writeRecords(couch, loginResult.userId, records);
    log("Bulk write completed", {
        results: results.length,
        durationMs: Date.now() - writeStart,
    });

    const successRows: CsvRow[] = [];
    const writeFailures: SkippedRow[] = [];

    for (let i = 0; i < results.length; i++) {
        if (results[i].ok) {
            successRows.push(originalRows[i]);
        } else {
            writeFailures.push({
                row: originalRows[i],
                reason: `CouchDB rejected: ${results[i].error} — ${results[i].reason}`,
            });
        }
    }

    log("Write split summary", {
        success: successRows.length,
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

    if (allFailures.length > 0) {
        console.log(`✗ ${allFailures.length} rows failed`);
        console.log(`  (${skipped.length} bad data, ${writeFailures.length} CouchDB rejections)`);
    }

    console.log();
    console.log(`Success CSV → ${successPath}`);
    console.log(`Failure CSV → ${failurePath}`);
    console.log(`Run log → ${logFilePath}`);
    log("Run completed", {
        successRows: successRows.length,
        failureRows: allFailures.length,
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
