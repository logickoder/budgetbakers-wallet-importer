import test from "node:test";
import assert from "node:assert/strict";

import { filterRecordsByCreatedWindow, runMaintenanceMode, summarizeDeleteResults } from "../../cli/maintenance.js";
import type { ListedRecord, RecordDocRef } from "../../records.js";
import type { BulkResult } from "../../types.js";
import type { Logger } from "../../logger.js";
import type { RunOptions } from "../../cli/options/types.js";
import type { AxiosInstance } from "axios";

function makeRecord(id: string, createdAt: string, batchId: string | null = null): ListedRecord {
    return {
        ref: { _id: id, _rev: "1-a" },
        createdAt,
        recordDate: createdAt,
        amount: 100,
        accountId: "-Account_a",
        importBatchId: batchId,
    };
}

function makeLogger(): Logger {
    const base = ((_: string, __?: unknown): void => undefined) as Logger;
    base.warn = (_: string, __?: unknown): void => undefined;
    base.error = (_: string, __?: unknown): void => undefined;
    base.logFilePath = "test.log";
    return base;
}

function baseRunOptions(overrides: Partial<RunOptions> = {}): RunOptions {
    return {
        debug: false,
        refreshCache: false,
        logLevel: "info",
        email: null,
        csvPath: null,
        yes: true,
        listLastRequested: false,
        rollbackLastRequested: false,
        listLastRecords: 0,
        rollbackLastRecords: 0,
        startTimestamp: null,
        endTimestamp: null,
        rollbackImportRequested: false,
        rollbackImportId: null,
        batchId: null,
        dryRun: false,
        ...overrides,
    };
}

test("filterRecordsByCreatedWindow keeps records inside inclusive bounds", () => {
    const records = [
        makeRecord("Record_1", "2026-03-23T08:00:00.000Z"),
        makeRecord("Record_2", "2026-03-23T08:30:00.000Z"),
        makeRecord("Record_3", "2026-03-23T09:00:00.000Z"),
    ];

    const filtered = filterRecordsByCreatedWindow(records, {
        startTimestamp: "2026-03-23T08:15:00.000Z",
        endTimestamp: "2026-03-23T09:00:00.000Z",
    });

    assert.deepEqual(filtered.map((r) => r.ref._id), ["Record_2", "Record_3"]);
});

test("summarizeDeleteResults counts successes and failures", () => {
    const summary = summarizeDeleteResults([
        { id: "Record_1", ok: true, rev: "2-a" },
        { id: "Record_2", error: "conflict", reason: "Document update conflict." },
    ]);

    assert.equal(summary.successCount, 1);
    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0].id, "Record_2");
});

test("runMaintenanceMode rollback-import deletes records for that batch only", async () => {
    const batchId = "617b1204-9ef6-4bfa-8b04-03d0d509d7db";
    const fetched = [
        makeRecord("Record_1", "2026-06-01T00:00:00Z", batchId),
        makeRecord("Record_2", "2026-06-01T00:00:01Z", batchId),
    ];

    let listCalls = 0;
    let deleteCalls = 0;
    let deletedDocs: RecordDocRef[] = [];

    const exit = await runMaintenanceMode({
        couch: {} as AxiosInstance,
        options: baseRunOptions({
            rollbackImportRequested: true,
            rollbackImportId: batchId,
            yes: true,
        }),
        ask: async () => "DELETE",
        log: makeLogger(),
        listRecordsByBatch: async (_couch, id) => {
            listCalls += 1;
            assert.equal(id, batchId);
            return fetched;
        },
        deleteRecords: async (_couch, docs): Promise<BulkResult[]> => {
            deleteCalls += 1;
            deletedDocs = docs;
            return docs.map((d) => ({ id: d._id, ok: true, rev: "2-a" }));
        },
    });

    assert.equal(exit, 0);
    assert.equal(listCalls, 1);
    assert.equal(deleteCalls, 1);
    assert.deepEqual(deletedDocs.map((d) => d._id), ["Record_1", "Record_2"]);
});

test("runMaintenanceMode rollback-import returns 0 and skips delete when batch empty", async () => {
    const batchId = "617b1204-9ef6-4bfa-8b04-03d0d509d7db";
    let deleteCalls = 0;

    const exit = await runMaintenanceMode({
        couch: {} as AxiosInstance,
        options: baseRunOptions({
            rollbackImportRequested: true,
            rollbackImportId: batchId,
        }),
        ask: async () => "DELETE",
        log: makeLogger(),
        listRecordsByBatch: async () => [],
        deleteRecords: async (): Promise<BulkResult[]> => {
            deleteCalls += 1;
            return [];
        },
    });

    assert.equal(exit, 0);
    assert.equal(deleteCalls, 0);
});
