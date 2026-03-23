import type { AxiosInstance } from "axios";

import type { Logger } from "../logger.js";
import {
    deleteRecords as deleteRecordsFromCouch,
    listLastRecords as listLastRecordsFromCouch,
} from "../records.js";
import type { ListedRecord, RecordDocRef } from "../records.js";
import type { BulkResult } from "../types.js";
import type { RunOptions } from "./options/types.js";

interface TimeWindow {
    startTimestamp: string | null;
    endTimestamp: string | null;
}

interface RunMaintenanceModeParams {
    couch: AxiosInstance;
    options: RunOptions;
    ask: (question: string) => Promise<string>;
    log: Logger;
    listLastRecords?: (couch: AxiosInstance, limit: number) => Promise<ListedRecord[]>;
    deleteRecords?: (couch: AxiosInstance, docs: RecordDocRef[]) => Promise<BulkResult[]>;
}

function parseTimestampMs(timestamp: string | null): number | null {
    if (!timestamp) return null;
    const ms = Date.parse(timestamp);
    if (Number.isNaN(ms)) return null;
    return ms;
}

export function filterRecordsByCreatedWindow(records: ListedRecord[], window: TimeWindow): ListedRecord[] {
    const startMs = parseTimestampMs(window.startTimestamp);
    const endMs = parseTimestampMs(window.endTimestamp);

    return records.filter((record) => {
        const createdMs = Date.parse(record.createdAt);
        if (Number.isNaN(createdMs)) return false;
        if (startMs !== null && createdMs < startMs) return false;
        if (endMs !== null && createdMs > endMs) return false;
        return true;
    });
}

export function summarizeDeleteResults(results: BulkResult[]): {
    successCount: number;
    failed: BulkResult[];
} {
    return {
        successCount: results.filter((result) => result.ok).length,
        failed: results.filter((result) => result.error),
    };
}

function printRecords(requestedCount: number, filtered: ListedRecord[]): void {
    console.log(`\nLast ${requestedCount} records (showing ${filtered.length} after created-time filter):`);
    for (let i = 0; i < filtered.length; i++) {
        const doc = filtered[i];
        console.log(
            `  [${i + 1}] ${doc.ref._id} | created=${doc.createdAt} | `
            + `recordDate=${doc.recordDate} | amount=${doc.amount} | account=${doc.accountId}`
        );
    }
}

export async function runMaintenanceMode(params: RunMaintenanceModeParams): Promise<number | null> {
    const {
        couch,
        options,
        ask,
        log,
        listLastRecords = listLastRecordsFromCouch,
        deleteRecords = deleteRecordsFromCouch,
    } = params;

    if (!options.listLastRequested && !options.rollbackLastRequested) {
        return null;
    }

    const requestedCount = options.rollbackLastRequested ? options.rollbackLastRecords : options.listLastRecords;
    const rollbackMode = options.rollbackLastRequested;
    const window: TimeWindow = {
        startTimestamp: options.startTimestamp,
        endTimestamp: options.endTimestamp,
    };

    console.log(`${rollbackMode ? "Preparing rollback" : "Fetching recent records"}...`);
    if (window.startTimestamp || window.endTimestamp) {
        console.log(
            `Applying timestamp filter: start=${window.startTimestamp ?? "-"}, `
            + `end=${window.endTimestamp ?? "-"}`
        );
    }

    const records = await listLastRecords(couch, requestedCount);
    log("Recent records fetched", {
        requestedCount,
        fetchedCount: records.length,
        rollbackMode,
        startTimestamp: window.startTimestamp,
        endTimestamp: window.endTimestamp,
    });

    if (!records.length) {
        console.log("No records found.");
        return 0;
    }

    const filtered = filterRecordsByCreatedWindow(records, window);
    log("Recent records post-filtered by created timestamp", {
        fetchedCount: records.length,
        filteredCount: filtered.length,
        startTimestamp: window.startTimestamp,
        endTimestamp: window.endTimestamp,
    });

    if (!filtered.length) {
        console.log("No records found after timestamp filter.");
        return 0;
    }

    printRecords(requestedCount, filtered);

    if (!rollbackMode) {
        return 0;
    }

    if (!options.yes) {
        const confirm = await ask(`\nDelete these ${filtered.length} records permanently? Type DELETE to continue: `);
        if (confirm.trim() !== "DELETE") {
            console.log("Rollback aborted.");
            return 0;
        }
    }

    console.log("\nDeleting records...");
    const results = await deleteRecords(couch, filtered.map((entry) => entry.ref));
    const { successCount, failed } = summarizeDeleteResults(results);

    console.log(`✓ Deleted ${successCount} record(s)`);
    if (failed.length > 0) {
        console.log(`✗ Failed to delete ${failed.length} record(s)`);
        for (const entry of failed) {
            console.log(`  - ${entry.id}: ${entry.error} — ${entry.reason}`);
        }
        return 1;
    }

    return 0;
}
