import test from "node:test";
import assert from "node:assert/strict";

import { toIso } from "../csv.js";

test("toIso parses US short date with space separator", () => {
    const parsed = toIso("3/20/26 21:05");
    assert.match(parsed, /^2026-03-20T21:05:00\.000[+-]\d{2}:\d{2}$/);
});
