import test from "node:test";
import assert from "node:assert/strict";

import type { Logger } from "../../logger.js";
import type { LookupCacheSnapshot, LookupData, LookupMaps } from "../../types.js";
import type { NewRecord } from "../../types.js";
import { buildImportPreview, printImportPreview, resolveLookupData } from "../../cli/run.js";

function makeLogger(): Logger {
    const base = ((_: string, __?: unknown): void => undefined) as Logger;
    base.warn = (_: string, __?: unknown): void => undefined;
    base.error = (_: string, __?: unknown): void => undefined;
    base.logFilePath = "test.log";
    return base;
}

function sampleLookupData(): LookupData {
    return {
        accounts: [{ _id: "-Account_a", _rev: "1-a", name: "Main", currencyId: "-Currency_ngn", position: 0, archived: false }],
        categories: [{ _id: "-Category_t", _rev: "1-c", name: "Transfer, withdraw", defaultType: 1 }],
        currencies: [{ _id: "-Currency_ngn", _rev: "1-c", code: "NGN" }],
    };
}

function sampleLookupMaps(): LookupMaps {
    return {
        accounts: { Main: "-Account_a" },
        accountCurrencies: { Main: "-Currency_ngn" },
        categories: { "Transfer, withdraw": "-Category_t" },
        currencies: { NGN: "-Currency_ngn" },
        transferCategoryId: "-Category_t",
    };
}

function sampleCache(userId: string): LookupCacheSnapshot {
    return {
        data: sampleLookupData(),
        maps: sampleLookupMaps(),
        metadata: {
            version: 1,
            source: "cache",
            generatedAt: new Date().toISOString(),
            email: "you@example.com",
            userKey: "abc",
            userId,
            counts: { accounts: 1, categories: 1, currencies: 1 },
            transferCategoryId: "-Category_t",
        },
    };
}

test("resolveLookupData uses cache when valid and refresh disabled", async () => {
    let fetchCalls = 0;
    let persistCalls = 0;

    const result = await resolveLookupData({
        email: "you@example.com",
        userId: "user-1",
        refreshCache: false,
        loadCache: () => sampleCache("user-1"),
        fetchLookupData: async () => {
            fetchCalls += 1;
            return sampleLookupData();
        },
        buildLookupMaps: () => sampleLookupMaps(),
        persistCache: () => {
            persistCalls += 1;
        },
        log: makeLogger(),
    });

    assert.equal(result.source, "cache");
    assert.equal(fetchCalls, 0);
    assert.equal(persistCalls, 0);
});

test("resolveLookupData fetches from couch when refresh enabled", async () => {
    let fetchCalls = 0;
    let persistCalls = 0;

    const result = await resolveLookupData({
        email: "you@example.com",
        userId: "user-1",
        refreshCache: true,
        loadCache: () => sampleCache("user-1"),
        fetchLookupData: async () => {
            fetchCalls += 1;
            return sampleLookupData();
        },
        buildLookupMaps: () => sampleLookupMaps(),
        persistCache: () => {
            persistCalls += 1;
        },
        log: makeLogger(),
    });

    assert.equal(result.source, "couch");
    assert.equal(fetchCalls, 1);
    assert.equal(persistCalls, 1);
});

test("resolveLookupData fetches from couch when cache belongs to different user", async () => {
    let fetchCalls = 0;

    const result = await resolveLookupData({
        email: "you@example.com",
        userId: "user-2",
        refreshCache: false,
        loadCache: () => sampleCache("user-1"),
        fetchLookupData: async () => {
            fetchCalls += 1;
            return sampleLookupData();
        },
        buildLookupMaps: () => sampleLookupMaps(),
        persistCache: () => undefined,
        log: makeLogger(),
    });

    assert.equal(result.source, "couch");
    assert.equal(fetchCalls, 1);
});

function previewRecord(overrides: Partial<NewRecord> = {}): NewRecord {
    return {
        accountId: "-Account_a",
        currencyId: "-Currency_ngn",
        categoryId: "-Category_t",
        amount: 5375,
        type: 1,
        note: "Stamp Duty",
        recordDate: "2026-01-27T02:31:00.000+01:00",
        paymentType: 0,
        transfer: false,
        ...overrides,
    };
}

test("buildImportPreview groups by account and signs net for income/expense", () => {
    const records = [
        previewRecord({ accountId: "-Account_a", amount: 1000, type: 1 }),
        previewRecord({ accountId: "-Account_a", amount: 300, type: 0 }),
        previewRecord({ accountId: "-Account_b", amount: 500, type: 1 }),
    ];
    const maps = sampleLookupMaps();
    maps.accounts = { Main: "-Account_a", Side: "-Account_b" };

    const preview = buildImportPreview(records, maps);

    assert.equal(preview.totalRecords, 3);
    assert.equal(preview.sampleSize, 3);

    const main = preview.accountTotals.find((t) => t.accountName === "Main");
    const side = preview.accountTotals.find((t) => t.accountName === "Side");

    assert.ok(main);
    assert.equal(main.count, 2);
    assert.equal(main.net, -700);

    assert.ok(side);
    assert.equal(side.count, 1);
    assert.equal(side.net, -500);
});

test("printImportPreview emits per-account totals and sample lines", () => {
    const records = [
        previewRecord({ amount: 5375, type: 1, note: "Stamp Duty" }),
    ];
    const maps = sampleLookupMaps();
    const preview = buildImportPreview(records, maps);

    const lines: string[] = [];
    printImportPreview(preview, (line) => lines.push(line));

    const joined = lines.join("\n");
    assert.match(joined, /Preview:/);
    assert.match(joined, /Per-account totals:/);
    assert.match(joined, /Main · 1 rows · net -53\.75/);
    assert.match(joined, /Stamp Duty/);
});
