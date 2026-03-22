import test from "node:test";
import assert from "node:assert/strict";

import type { Logger } from "../logger.js";
import type { LookupCacheSnapshot, LookupData, LookupMaps } from "../types.js";
import { resolveLookupData } from "./run.js";

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
