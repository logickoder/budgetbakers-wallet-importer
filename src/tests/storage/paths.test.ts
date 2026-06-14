import test from "node:test";
import assert from "node:assert/strict";

import { isValidEmail } from "../../storage/paths.js";

test("isValidEmail accepts standard addresses", () => {
    assert.equal(isValidEmail("you@example.com"), true);
    assert.equal(isValidEmail("first.last+tag@example.co.uk"), true);
});

test("isValidEmail rejects whitespace, missing @, and bare strings", () => {
    assert.equal(isValidEmail(""), false);
    assert.equal(isValidEmail("refresh cache"), false);
    assert.equal(isValidEmail("you@"), false);
    assert.equal(isValidEmail("you@example"), false);
    assert.equal(isValidEmail("you @example.com"), false);
});
