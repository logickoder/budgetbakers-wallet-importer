import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
    bankstractToCsvRows,
    loadBankMap,
    readBankstractInput,
    type BankstractInput,
} from "../bankstract.js";

function tmpFile(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bankstract-test-"));
    const file = path.join(dir, name);
    fs.writeFileSync(file, content, "utf8");
    return file;
}

const SAMPLE_JSON = JSON.stringify({
    format_version: "0.15",
    metadata: { bank: "fbn", account_holder: "Jane Doe" },
    totals: { credit: "300000", debit: "53.75" },
    transactions: [
        {
            date: "2026-01-27T02:31:00",
            narration: "Stamp Duty",
            debit: "53.75",
            credit: "0",
            balance: "100",
            reference: "REF123",
            currency: "NGN",
        },
        {
            date: "2026-01-29T13:33:00",
            narration: "Salary",
            debit: "0",
            credit: "300000",
            balance: "300100",
            reference: "",
            currency: "NGN",
        },
    ],
});

test("readBankstractInput reads JSON and takes bank from metadata", () => {
    const file = tmpFile("statement.json", SAMPLE_JSON);
    const input = readBankstractInput(file, null);
    assert.equal(input.bank, "fbn");
    assert.equal(input.transactions.length, 2);
});

test("readBankstractInput --bank override wins over JSON metadata", () => {
    const file = tmpFile("statement.json", SAMPLE_JSON);
    const input = readBankstractInput(file, "opay");
    assert.equal(input.bank, "opay");
});

test("readBankstractInput reads CSV; bank comes only from override", () => {
    const csv =
        "date,narration,debit,credit,balance,reference,currency\n" +
        "2026-01-27T02:31:00,Stamp Duty,53.75,0,,REF123,NGN\n";
    const file = tmpFile("statement.csv", csv);

    const noBank = readBankstractInput(file, null);
    assert.equal(noBank.bank, null);
    assert.equal(noBank.transactions.length, 1);

    const withBank = readBankstractInput(file, "fbn");
    assert.equal(withBank.bank, "fbn");
});

test("readBankstractInput throws on JSON without transactions array", () => {
    const file = tmpFile("bad.json", JSON.stringify({ metadata: { bank: "fbn" } }));
    assert.throws(() => readBankstractInput(file, null), /transactions/);
});

test("bankstractToCsvRows signs amount as credit minus debit", () => {
    const input: BankstractInput = {
        bank: "fbn",
        transactions: [
            { date: "d1", narration: "n", debit: "53.75", credit: "0" },
            { date: "d2", narration: "n", debit: "0", credit: "300000" },
            { date: "d3", narration: "n", debit: "10.50", credit: "0.50" },
        ],
    };
    const rows = bankstractToCsvRows(input, {}, "");
    assert.equal(rows[0].amount, "-53.75");
    assert.equal(rows[1].amount, "300000");
    assert.equal(rows[2].amount, "-10");
});

test("bankstractToCsvRows resolves account from bank map, blank when unmapped", () => {
    const input: BankstractInput = {
        bank: "fbn",
        transactions: [{ date: "d", narration: "n", debit: "0", credit: "1" }],
    };
    assert.equal(bankstractToCsvRows(input, { fbn: "First Bank" }, "")[0].account, "First Bank");
    assert.equal(bankstractToCsvRows(input, { opay: "OPay" }, "")[0].account, "");
    assert.equal(bankstractToCsvRows({ ...input, bank: null }, { fbn: "First Bank" }, "")[0].account, "");
});

test("bankstractToCsvRows applies default category and leaves payee blank", () => {
    const input: BankstractInput = {
        bank: "fbn",
        transactions: [{ date: "d", narration: "n", debit: "0", credit: "1" }],
    };
    const rows = bankstractToCsvRows(input, {}, "Uncategorised");
    assert.equal(rows[0].category, "Uncategorised");
    assert.equal(rows[0].payee, "");
});

test("bankstractToCsvRows folds reference into note", () => {
    const input: BankstractInput = {
        bank: "fbn",
        transactions: [
            { date: "d", narration: "Salary", debit: "0", credit: "1", reference: "REF1" },
            { date: "d", narration: "Salary", debit: "0", credit: "1", reference: "" },
            { date: "d", narration: "", debit: "0", credit: "1", reference: "REF2" },
        ],
    };
    const rows = bankstractToCsvRows(input, {}, "");
    assert.equal(rows[0].note, "Salary (Ref: REF1)");
    assert.equal(rows[1].note, "Salary");
    assert.equal(rows[2].note, "Ref: REF2");
});

test("end-to-end: JSON statement maps to importer rows", () => {
    const file = tmpFile("statement.json", SAMPLE_JSON);
    const input = readBankstractInput(file, null);
    const rows = bankstractToCsvRows(input, { fbn: "First Bank" }, "Uncategorised");

    assert.deepEqual(rows[0], {
        date: "2026-01-27T02:31:00",
        account: "First Bank",
        amount: "-53.75",
        category: "Uncategorised",
        note: "Stamp Duty (Ref: REF123)",
        payee: "",
    });
    assert.equal(rows[1].amount, "300000");
    assert.equal(rows[1].note, "Salary");
});

test("loadBankMap reads a flat string map", () => {
    const file = tmpFile("map.json", JSON.stringify({ fbn: "First Bank", opay: "OPay" }));
    assert.deepEqual(loadBankMap(file), { fbn: "First Bank", opay: "OPay" });
});

test("loadBankMap rejects non-object and non-string values", () => {
    const arr = tmpFile("arr.json", JSON.stringify(["a", "b"]));
    assert.throws(() => loadBankMap(arr), /object/);

    const badVal = tmpFile("bad.json", JSON.stringify({ fbn: 123 }));
    assert.throws(() => loadBankMap(badVal), /must be a string/);
});
