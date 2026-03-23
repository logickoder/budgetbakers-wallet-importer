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
            && error.message.includes("Use either --list-last or --rollback-last")
    );
});

test("parseRunOptionsOrThrow emits help signal", () => {
    assert.throws(
        () => parseRunOptionsOrThrow(["--help"]),
        (error: unknown) => error instanceof OptionsParseError && error.code === "help"
    );
});
