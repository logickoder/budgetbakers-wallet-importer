import test from "node:test";
import assert from "node:assert/strict";

import { toLocalIsoDateTime } from "../date-time.js";

test("toLocalIsoDateTime parses US short date with space separator", () => {
    const parsed = toLocalIsoDateTime("3/20/26 21:05");
    assert.match(parsed, /^2026-03-20T21:05:00\.000[+-]\d{2}:\d{2}$/);
});

test("toLocalIsoDateTime rejects invalid date values", () => {
    assert.throws(() => toLocalIsoDateTime("not-a-date"), /Invalid date/);
});
