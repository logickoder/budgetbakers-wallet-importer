import test from "node:test";
import assert from "node:assert/strict";

import type { LookupMaps, NewRecord } from "../../types.js";
import { buildImportPreview, printImportPreview } from "../../cli/preview.js";

function sampleMaps(): LookupMaps {
    return {
        accounts: { Main: "-Account_a" },
        accountCurrencies: { Main: "-Currency_ngn" },
        categories: { "Transfer, withdraw": "-Category_t" },
        currencies: { NGN: "-Currency_ngn" },
        transferCategoryId: "-Category_t",
    };
}

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
    const maps = sampleMaps();
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
    const preview = buildImportPreview(records, sampleMaps());

    const lines: string[] = [];
    printImportPreview(preview, (line) => lines.push(line));

    const joined = lines.join("\n");
    assert.match(joined, /Preview:/);
    assert.match(joined, /Per-account totals:/);
    assert.match(joined, /Main · 1 rows · net -53\.75/);
    assert.match(joined, /Stamp Duty/);
});
