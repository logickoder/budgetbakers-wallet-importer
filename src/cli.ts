#!/usr/bin/env node
/**
 * @file cli.ts
 * @description Interactive terminal importer for BudgetBakers with optional debug logging.
 *
 * Usage:
 *   pnpm start
 *   pnpm start -- --no-debug
 *   # or after build:
 *   node dist/cli.js
 *
 * Flags:
 *   --debug      Enable verbose debug logs (default)
 *   --no-debug   Disable verbose debug logs
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
 * Session token is saved to `.budgetbakers-session` in the current directory.
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
import { createLogger } from "./logger.js";
import { writeLookupDumpFiles } from "./utils.js";

const SESSION_FILE = ".budgetbakers-session";

interface RunOptions {
  debug: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseRunOptions(args: string[]): RunOptions {
  let debug = true;

  for (const arg of args) {
    if (arg === "--debug") debug = true;
    else if (arg === "--no-debug") debug = false;
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: budgetbakers-importer [--debug|--no-debug]");
      console.log("  --debug      Enable verbose debug logs (default)");
      console.log("  --no-debug   Disable verbose debug logs");
      process.exit(0);
    }
  }

  return { debug };
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

function loadSession(): string | null {
  try {
    return fs.existsSync(SESSION_FILE)
      ? fs.readFileSync(SESSION_FILE, "utf8").trim()
      : null;
  } catch {
    return null;
  }
}

function saveSession(token: string): void {
  fs.writeFileSync(SESSION_FILE, token, "utf8");
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
  const debug = createLogger(options.debug);

  console.log("\n── BudgetBakers CSV Importer ──\n");
  debug("Run options", options);

  // ── Step 1: Email ───────────────────────────────────────────────────────────
  const email = await ask("Email address: ");
  if (!email) {
    console.error("Email is required.");
    process.exit(1);
  }

  // ── Step 2: Auth ────────────────────────────────────────────────────────────
  const savedToken = loadSession();
  if (savedToken) console.log("Found saved session — skipping SSO.\n");
  debug("Session state", { hasSavedToken: Boolean(savedToken) });

  let loginResult;
  try {
    loginResult = await login(email, savedToken, debug);
  } catch (error) {
    debug("Initial login attempt failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    // Session may be stale — clear it and retry with a fresh SSO flow.
    if (savedToken) {
      console.log("Session expired — starting fresh SSO flow.\n");
      fs.unlinkSync(SESSION_FILE);
      loginResult = await login(email, null, debug);
    } else {
      throw new Error("Login failed", { cause: error });
    }
  }

  saveSession(loginResult.sessionToken);
  debug("Login succeeded", {
    userId: loginResult.userId,
    hasReplicationToken: Boolean(loginResult.replication?.token),
  });
  console.log(`\nLogged in as ${email}\n`);

  // ── Step 3: Fetch lookup maps ───────────────────────────────────────────────
  console.log("Fetching accounts, categories and currencies from CouchDB...");
  const couch = buildCouchClient(loginResult.replication);
  const lookupData = await fetchLookupData(couch);
  const maps = buildLookupMapsFromData(lookupData);

  if (options.debug) {
    try {
      const dump = writeLookupDumpFiles(lookupData, maps, loginResult.userId);
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
  const results = await writeRecords(couch, loginResult.userId, records);
  debug("Bulk write completed", { results: results.length });

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

  // All failure rows = pre-write skips + CouchDB rejections.
  const allFailures: SkippedRow[] = [...skipped, ...writeFailures];

  // ── Step 10: Write output CSVs ──────────────────────────────────────────────
  fs.writeFileSync(successPath, rowsToCsv(successRows), "utf8");
  fs.writeFileSync(failurePath, skippedRowsToCsv(allFailures), "utf8");

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
