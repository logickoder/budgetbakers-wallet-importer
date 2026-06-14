import test from "node:test";
import assert from "node:assert/strict";

import { OptionsParseError, parseRunOptionsOrThrow } from "../../../cli/options/core.js";

test("parseRunOptionsOrThrow parses maintenance args", () => {
    const options = parseRunOptionsOrThrow([
        "--rollback-last",
        "20",
        "--start-ts",
        "2026-03-23T08:00:00Z",
        "--end-ts",
        "2026-03-23T09:00:00Z",
        "--yes",
    ]);

    assert.equal(options.rollbackLastRequested, true);
    assert.equal(options.rollbackLastRecords, 20);
    assert.equal(options.startTimestamp, "2026-03-23T08:00:00.000Z");
    assert.equal(options.endTimestamp, "2026-03-23T09:00:00.000Z");
    assert.equal(options.yes, true);
});

test("parseRunOptionsOrThrow rejects start/end without list or rollback mode", () => {
    assert.throws(
        () => parseRunOptionsOrThrow(["--start-ts", "2026-03-23T08:00:00Z"]),
        (error: unknown) => error instanceof OptionsParseError
            && error.message.includes("can only be used with --list-last or --rollback-last")
    );
});

test("parseRunOptionsOrThrow rejects conflicting maintenance flags", () => {
    assert.throws(
        () => parseRunOptionsOrThrow(["--list-last", "20", "--rollback-last", "20"]),
        (error: unknown) => error instanceof OptionsParseError
            && error.message.includes("Use only one of --list-last, --rollback-last, or --rollback-import")
    );
});

test("parseRunOptionsOrThrow emits help signal", () => {
    assert.throws(
        () => parseRunOptionsOrThrow(["--help"]),
        (error: unknown) => error instanceof OptionsParseError && error.code === "help"
    );
});

test("parseRunOptionsOrThrow parses --rollback-import uuid", () => {
    const id = "617b1204-9ef6-4bfa-8b04-03d0d509d7db";
    const options = parseRunOptionsOrThrow(["--rollback-import", id, "--yes"]);

    assert.equal(options.rollbackImportRequested, true);
    assert.equal(options.rollbackImportId, id);
    assert.equal(options.yes, true);
});

test("parseRunOptionsOrThrow rejects invalid --rollback-import value", () => {
    assert.throws(
        () => parseRunOptionsOrThrow(["--rollback-import", "not-a-uuid"]),
        (error: unknown) => error instanceof OptionsParseError
            && error.message.includes("Invalid --rollback-import")
    );
});

test("parseRunOptionsOrThrow rejects --rollback-import combined with --rollback-last", () => {
    const id = "617b1204-9ef6-4bfa-8b04-03d0d509d7db";
    assert.throws(
        () => parseRunOptionsOrThrow(["--rollback-import", id, "--rollback-last", "5"]),
        (error: unknown) => error instanceof OptionsParseError
            && error.message.includes("Use only one of")
    );
});

test("parseRunOptionsOrThrow parses --batch-id", () => {
    const id = "617b1204-9ef6-4bfa-8b04-03d0d509d7db";
    const options = parseRunOptionsOrThrow(["--batch-id", id]);
    assert.equal(options.batchId, id);
});

test("parseRunOptionsOrThrow accepts --dry-run and --validate alias", () => {
    assert.equal(parseRunOptionsOrThrow(["--dry-run"]).dryRun, true);
    assert.equal(parseRunOptionsOrThrow(["--validate"]).dryRun, true);
});

test("parseRunOptionsOrThrow rejects --dry-run combined with --rollback-import", () => {
    const id = "617b1204-9ef6-4bfa-8b04-03d0d509d7db";
    assert.throws(
        () => parseRunOptionsOrThrow(["--dry-run", "--rollback-import", id]),
        (error: unknown) => error instanceof OptionsParseError
            && error.message.includes("--dry-run cannot be combined")
    );
});
