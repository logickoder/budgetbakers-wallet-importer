import test from "node:test";
import assert from "node:assert/strict";

import { deriveRecordId } from "../records.js";
import type { RecordIdentity } from "../types.js";

function sampleIdentity(): RecordIdentity {
    return {
        accountId: "-Account_a",
        recordDate: "2026-01-27T02:31:00.000+01:00",
        amount: 5375,
        type: 1,
        note: "Stamp Duty",
        payee: "",
        transfer: false,
    };
}

test("deriveRecordId is deterministic for same batch and identity", () => {
    const batchId = "617b1204-9ef6-4bfa-8b04-03d0d509d7db";
    const id1 = deriveRecordId(batchId, sampleIdentity());
    const id2 = deriveRecordId(batchId, sampleIdentity());
    assert.equal(id1, id2);
    assert.ok(id1.startsWith("Record_"));
});

test("deriveRecordId differs across batches", () => {
    const a = deriveRecordId("617b1204-9ef6-4bfa-8b04-03d0d509d7db", sampleIdentity());
    const b = deriveRecordId("c1d2e3f4-0a1b-4c2d-8e3f-405060708090", sampleIdentity());
    assert.notEqual(a, b);
});

test("deriveRecordId differs when identity fields differ", () => {
    const batchId = "617b1204-9ef6-4bfa-8b04-03d0d509d7db";
    const base = sampleIdentity();
    const baseId = deriveRecordId(batchId, base);

    const fieldsToChange: Array<Partial<RecordIdentity>> = [
        { accountId: "-Account_b" },
        { recordDate: "2026-01-27T02:31:01.000+01:00" },
        { amount: 5376 },
        { type: 0 },
        { note: "Other" },
        { payee: "Someone" },
        { transfer: true },
    ];

    for (const patch of fieldsToChange) {
        const mutated = deriveRecordId(batchId, { ...base, ...patch });
        assert.notEqual(mutated, baseId, `expected different id for patch ${JSON.stringify(patch)}`);
    }
});
