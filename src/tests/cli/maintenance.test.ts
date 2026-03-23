import test from "node:test";
import assert from "node:assert/strict";

import { filterRecordsByCreatedWindow, summarizeDeleteResults } from "../../cli/maintenance.js";
import type { ListedRecord } from "../../records.js";

function makeRecord(id: string, createdAt: string): ListedRecord {
    return {
        ref: { _id: id, _rev: "1-a" },
        createdAt,
        recordDate: createdAt,
        amount: 100,
        accountId: "-Account_a",
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
