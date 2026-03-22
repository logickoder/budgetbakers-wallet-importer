#!/usr/bin/env node
/**
 * @file cli.ts
 * @description Interactive terminal importer for BudgetBakers with optional debug logging.
 *
 * Usage:
 *   pnpm start
 *   pnpm start -- --no-debug
 *   pnpm start -- --refresh-cache
 *   pnpm start -- --log-level warn
 *   # or after build:
 *   node dist/cli.js
 *
 * Flags:
 *   --debug      Enable verbose debug logs (default)
 *   --no-debug   Disable verbose debug logs
 *   --refresh-cache  Force lookup refresh from CouchDB
 *   --log-level  Minimum log level for file/console output (info|warn|error)
 *
 * Flow:
 *   1.  Ask for email
 *   2.  Reuse saved session token if available, otherwise trigger SSO email
 *   3.  Fetch accounts, categories, currencies from CouchDB
 *   4.  Ask for CSV file path
 *   5.  Parse and convert rows
 *   6.  Show a pre-flight summary (ready / skipped counts + reasons)
 *   7.  Ask for confirmation
 *   8.  Write records in one _bulk_docs call
 *   9.  Split results into success and failure
 *   10. Write <name>_success.csv and <name>_failure.csv alongside the input
 *   11. Print final counts
 *
 * Sessions are indexed in `.budgetbakers-session.json` and persisted per user
 * under `data/<user-hash>/session.json`.
 *
 * Output files:
 *   <input>_success.csv  — rows that were written to BudgetBakers successfully
 *   <input>_failure.csv  — rows that were skipped (bad data) or rejected by
 *                          CouchDB, with a `reason` column explaining each
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { login } from "./auth.js";
import { buildCouchClient, buildLookupMapsFromData, fetchLookupData } from "./couch.js";
import { writeRecords } from "./records.js";
import type { CsvRow, SkippedRow } from "./csv.js";
import { convertRows, parseCsv, rowsToCsv, skippedRowsToCsv } from "./csv.js";
import { createLogger, type LogLevelName } from "./logger.js";
import {
  listSavedEmails,
  loadLookupCache,
  loadSessionIndex,
  loadUserSession,
  normalizeEmail,
  pruneUserLogs,
  removeUserSession,
  saveUserSession,
  userDataDir,
  writeLookupCache,
  writeLookupDumpFiles,
} from "./utils.js";
import type { SessionIndex } from "./types.js";

interface RunOptions {
  debug: boolean;
  refreshCache: boolean;
  logLevel: LogLevelName;
}

function makeRunId(): string {
  return new Date().toISOString().replace(/[.:]/g, "-");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseRunOptions(args: string[]): RunOptions {
  let debug = true;
  let refreshCache = false;
  let logLevel: LogLevelName = "info";

  const parseLogLevel = (value: string): LogLevelName | null => {
    const normalized = value.trim().toLowerCase();
    if (normalized === "info" || normalized === "warn" || normalized === "error") {
      return normalized;
    }
    return null;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--debug") debug = true;
    else if (arg === "--no-debug") debug = false;
    else if (arg === "--refresh-cache") refreshCache = true;
    else if (arg.startsWith("--log-level=")) {
      const parsed = parseLogLevel(arg.split("=")[1] ?? "");
      if (!parsed) {
        console.error("Invalid --log-level. Use: info, warn, or error.");
        process.exit(1);
      }
      logLevel = parsed;
    }
    else if (arg === "--log-level") {
      const parsed = parseLogLevel(args[i + 1] ?? "");
      if (!parsed) {
        console.error("Invalid --log-level. Use: info, warn, or error.");
        process.exit(1);
      }
      logLevel = parsed;
      i += 1;
    }
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: budgetbakers-importer [--debug|--no-debug] [--refresh-cache] [--log-level info|warn|error]");
      console.log("  --debug      Enable verbose debug logs (default)");
      console.log("  --no-debug   Disable verbose debug logs");
      console.log("  --refresh-cache   Force fresh lookup fetch from CouchDB");
      console.log("  --log-level       Minimum level written to logs (default: info)");
      process.exit(0);
    }
  }

  return { debug, refreshCache, logLevel };
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askRequiredEmail(prompt: string): Promise<string> {
  while (true) {
    const answer = normalizeEmail(await ask(prompt));
    if (answer) return answer;
    console.error("Email is required.");
  }
}

async function selectEmail(index: SessionIndex): Promise<string> {
  const savedEmails = listSavedEmails(index);

  if (savedEmails.length === 0) {
    return askRequiredEmail("Email address: ");
  }

  if (savedEmails.length === 1) {
    const onlyEmail = savedEmails[0];
    console.log(`Found saved session for ${onlyEmail}.`);
    const answer = await ask(
      `Press Enter to continue with ${onlyEmail}, or type a different email: `
    );
    return answer.trim() ? normalizeEmail(answer) : onlyEmail;
  }

  console.log("Saved sessions:");
  for (let i = 0; i < savedEmails.length; i++) {
    const email = savedEmails[i];
    const lastUsed = index.lastUsedEmail === email ? " (last used)" : "";
    console.log(`  [${i + 1}] ${email}${lastUsed}`);
  }

  while (true) {
    const answer = await ask(`Choose 1-${savedEmails.length} or type a new email: `);
    const trimmed = answer.trim();

    if (!trimmed && index.lastUsedEmail && savedEmails.includes(index.lastUsedEmail)) {
      return index.lastUsedEmail;
    }

    const selected = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(selected) && selected >= 1 && selected <= savedEmails.length) {
      return savedEmails[selected - 1];
    }

    const normalizedEmail = normalizeEmail(trimmed);
    if (normalizedEmail) return normalizedEmail;
    console.error("Please choose a valid number or provide an email.");
  }
}

/**
 * Derives output file paths from the input CSV path.
 *
 * Input:  /path/to/transactions.csv
 * Output: /path/to/transactions_success.csv
 *         /path/to/transactions_failure.csv
 */
function outputPaths(inputPath: string): { success: string; failure: string } {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  return {
    success: path.join(dir, `${base}_success${ext}`),
    failure: path.join(dir, `${base}_failure${ext}`),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const options = parseRunOptions(process.argv.slice(2));
  const runId = makeRunId();

  console.log("\n── BudgetBakers CSV Importer ──\n");

  // ── Step 1: Email ───────────────────────────────────────────────────────────
  let sessionIndex = loadSessionIndex();
  const email = await selectEmail(sessionIndex);
  const logFilePath = path.join(userDataDir(email), "logs", `importer-${runId}.log`);
  const debug = createLogger(options.debug, logFilePath, options.logLevel);
  const rotation = pruneUserLogs(email, 40);
  debug("Run options", options);
  debug("Log file initialized", { logFilePath });
  debug("Log rotation completed", rotation);

  const indexedSession = sessionIndex.users[email];
  const savedSession = loadUserSession(email) ?? (
    indexedSession
      ? {
        email,
        sessionToken: indexedSession.sessionToken,
        userId: indexedSession.userId,
        savedAt: indexedSession.savedAt,
      }
      : null
  );

  // ── Step 2: Auth ────────────────────────────────────────────────────────────
  if (savedSession) {
    console.log(`Found saved session for ${email} — skipping SSO.\n`);
  }
  debug("Session state", {
    hasSavedToken: Boolean(savedSession),
    selectedEmail: email,
    knownUsers: Object.keys(sessionIndex.users).length,
  });

  let loginResult;
  try {
    loginResult = await login(email, savedSession?.sessionToken ?? null, debug);
  } catch (error) {
    debug("Initial login attempt failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    // Session may be stale — remove this email entry and retry fresh SSO.
    if (savedSession) {
      console.log("Session expired — starting fresh SSO flow.\n");
      sessionIndex = removeUserSession(sessionIndex, email);
      loginResult = await login(email, null, debug);
    } else {
      throw new Error("Login failed", { cause: error });
    }
  }

  sessionIndex = saveUserSession(sessionIndex, email, loginResult.sessionToken, loginResult.userId);
  debug("Login succeeded", {
    userId: loginResult.userId,
    hasReplicationToken: Boolean(loginResult.replication?.token),
  });
  console.log(`\nLogged in as ${email}\n`);

  // ── Step 3: Fetch lookup maps ───────────────────────────────────────────────
  if (options.refreshCache) {
    console.log("Refreshing lookup cache from CouchDB...");
  } else {
    console.log("Loading lookup data (cache-first)...");
  }

  const couch = buildCouchClient(loginResult.replication);
  debug("CouchDB client initialized", {
    dbName: loginResult.replication.dbName,
    baseUrl: loginResult.replication.url,
  });

  let cacheSource: "cache" | "couch" = "couch";
  let lookupData;
  let maps;

  if (!options.refreshCache) {
    const cached = loadLookupCache(email);
    if (cached && cached.metadata.userId === loginResult.userId) {
      lookupData = cached.data;
      maps = cached.maps;
      cacheSource = "cache";
      debug("Lookup cache hit", {
        path: userDataDir(email),
        generatedAt: cached.metadata.generatedAt,
      });
      console.log(`Lookup cache hit → ${userDataDir(email)}\n`);
    }
  }

  if (!lookupData || !maps) {
    console.log("Fetching accounts, categories and currencies from CouchDB...");
    debug("CouchDB lookup fetch started");
    const lookupStart = Date.now();
    lookupData = await fetchLookupData(couch);
    debug("CouchDB lookup fetch finished", {
      durationMs: Date.now() - lookupStart,
      accounts: lookupData.accounts.length,
      categories: lookupData.categories.length,
      currencies: lookupData.currencies.length,
    });

    maps = buildLookupMapsFromData(lookupData);
    writeLookupCache(email, loginResult.userId, lookupData, maps);
    cacheSource = "couch";
    debug("Lookup cache written", { path: userDataDir(email) });
  }

  if (options.debug) {
    try {
      const dump = writeLookupDumpFiles(email, lookupData, maps, loginResult.userId);
      console.log(`Debug lookup dumps → ${dump.dir}`);
      debug("Lookup debug dumps written", { dump });
    } catch (error) {
      console.error(
        "Warning: failed to write debug lookup dumps:",
        error instanceof Error ? error.message : String(error)
      );
      debug("Lookup debug dumps failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  debug("Lookup maps loaded", {
    source: cacheSource,
    accounts: Object.keys(maps.accounts).length,
    categories: Object.keys(maps.categories).length,
    currencies: Object.keys(maps.currencies).length,
  });

  console.log(
    `  ${Object.keys(maps.accounts).length} accounts  ·  ` +
    `${Object.keys(maps.categories).length} categories  ·  ` +
    `${Object.keys(maps.currencies).length} currencies\n`
  );

  // ── Step 4: CSV path ────────────────────────────────────────────────────────
  console.log("Expected CSV format:");
  console.log("  date,account,amount,category,note,payee");
  console.log("  2026-01-27 02:31:00,First Bank,-53.75,Charges & Fees,Stamp Duty,");
  console.log("  (account names must match exactly; category is exact except transfer aliases like TRANSFER)\n");

  const csvPath = await ask("Path to CSV file: ");
  const resolved = path.resolve(csvPath);
  debug("CSV path resolved", { input: csvPath, resolved });

  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const { success: successPath, failure: failurePath } = outputPaths(resolved);

  // ── Step 5: Parse and convert ───────────────────────────────────────────────
  console.log("\nParsing CSV...");
  const raw = fs.readFileSync(resolved, "utf8");
  const rows = parseCsv(raw);
  const { records, originalRows, skipped } = convertRows(rows, maps);
  debug("CSV parsed", {
    rows: rows.length,
    records: records.length,
    skipped: skipped.length,
  });

  // ── Step 6: Pre-flight summary ──────────────────────────────────────────────
  const dataRowCount = rows.filter(r => r.date?.trim()).length;

  console.log(`\n  Total rows:         ${dataRowCount}`);
  console.log(`  Ready to import:    ${records.length}`);
  console.log(`  Skipped (bad data): ${skipped.length}`);

  if (skipped.length > 0) {
    // Group by reason for a compact display.
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
    // Still write failure CSV for any skipped rows.
    if (skipped.length > 0) {
      fs.writeFileSync(failurePath, skippedRowsToCsv(skipped), "utf8");
      console.log(`Failure CSV written → ${failurePath}`);
    }
    process.exit(0);
  }

  // ── Step 7: Confirm ─────────────────────────────────────────────────────────
  console.log();
  const confirm = await ask(`Write ${records.length} records to BudgetBakers? [y/N] `);
  debug("Write confirmation answer", { answer: confirm });
  if (confirm.toLowerCase() !== "y") {
    console.log("Aborted.");
    process.exit(0);
  }

  // ── Step 8: Write to CouchDB ────────────────────────────────────────────────
  console.log("\nWriting records...");
  debug("CouchDB bulk write started", { recordCount: records.length });
  const writeStart = Date.now();
  const results = await writeRecords(couch, loginResult.userId, records);
  debug("Bulk write completed", {
    results: results.length,
    durationMs: Date.now() - writeStart,
  });

  // ── Step 9: Split into success and failure ──────────────────────────────────
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
  debug("Write split summary", {
    success: successRows.length,
    writeFailures: writeFailures.length,
  });

  if (writeFailures.length > 0) {
    debug.warn("CouchDB reported write failures", {
      count: writeFailures.length,
      failures: writeFailures.slice(0, 10),
    });
  }

  // All failure rows = pre-write skips + CouchDB rejections.
  const allFailures: SkippedRow[] = [...skipped, ...writeFailures];

  // ── Step 10: Write output CSVs ──────────────────────────────────────────────
  fs.writeFileSync(successPath, rowsToCsv(successRows), "utf8");
  fs.writeFileSync(failurePath, skippedRowsToCsv(allFailures), "utf8");
  debug("Output files written", { successPath, failurePath });

  // ── Step 11: Final report ───────────────────────────────────────────────────
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
  debug("Run completed", {
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
