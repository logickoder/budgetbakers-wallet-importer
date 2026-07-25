import test from "node:test";
import assert from "node:assert/strict";

import { convertRows, toIso } from "../csv.js";
import type { CsvRow } from "../csv.js";
import type { LookupMaps } from "../types.js";

test("toIso parses US short date with space separator", () => {
    const parsed = toIso("3/20/26 21:05");
    assert.match(parsed, /^2026-03-20T21:05:00\.000[+-]\d{2}:\d{2}$/);
});

const MAPS: LookupMaps = {
    accounts: { "First Bank": "-Account_1" },
    accountCurrencies: { "First Bank": "-Currency_1" },
    categories: { Groceries: "-Category_1" },
    currencies: { NGN: "-Currency_1" },
    transferCategoryId: null,
};

function row(overrides: Partial<CsvRow>): CsvRow {
    return { date: "2026-01-01 10:00:00", account: "First Bank", amount: "-10", category: "Groceries", note: "", payee: "", ...overrides };
}

test("convertRows routes a blank-account row to skipped, not silent drop", () => {
    const result = convertRows([row({ account: "" })], MAPS);
    assert.equal(result.records.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /account/i);
});

test("convertRows skips a fully-empty line without recording a failure", () => {
    const result = convertRows([row({ date: "", account: "", amount: "", category: "", note: "", payee: "" })], MAPS);
    assert.equal(result.records.length, 0);
    assert.equal(result.skipped.length, 0);
});

test("convertRows fails a data row missing only date+account (not a blank line)", () => {
    const result = convertRows([row({ date: "", account: "", amount: "-10", category: "Groceries" })], MAPS);
    assert.equal(result.records.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /account/i);
});
