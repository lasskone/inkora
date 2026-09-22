import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatCents,
  parseDecimalToCents,
  percentOfCents,
  percentRatioCents,
  sumCents,
} from "@/lib/economics/money";

/**
 * Money is the foundation of every figure the economics engine emits, so the
 * parser/formatter contract is pinned here: no binary floating point, exact
 * half-up rounding, and `null` for anything uninterpretable.
 */

test("parses decimal strings into exact minor units", () => {
  assert.equal(parseDecimalToCents("29.99"), 2999);
  assert.equal(parseDecimalToCents("0.30"), 30);
  assert.equal(parseDecimalToCents("1000"), 100000);
  assert.equal(parseDecimalToCents("4.7"), 470);
  assert.equal(parseDecimalToCents(".99"), 99);
});

test("parses numbers without introducing binary float error", () => {
  // 29.99 * 100 would be 2998.9999... in float; the string path is exact.
  assert.equal(parseDecimalToCents(29.99), 2999);
  assert.equal(parseDecimalToCents(0.1 + 0.2), 30);
});

test("parses the low end of a documented CJ price range", () => {
  // CJ returns sellPrice as e.g. "23.36 -- 23.42"; the first token is the low end.
  assert.equal(parseDecimalToCents("23.36 -- 23.42"), 2336);
});

test("parses negative amounts and keeps the sign", () => {
  assert.equal(parseDecimalToCents("-12.34"), -1234);
  assert.equal(parseDecimalToCents("-0.01"), -1);
});

test("returns null for uninterpretable input instead of a guessed zero", () => {
  assert.equal(parseDecimalToCents(null), null);
  assert.equal(parseDecimalToCents(undefined), null);
  assert.equal(parseDecimalToCents(""), null);
  assert.equal(parseDecimalToCents("free"), null);
  assert.equal(parseDecimalToCents("N/A"), null);
});

test("rounds half up on the third fractional digit", () => {
  assert.equal(parseDecimalToCents("0.005"), 1);
  assert.equal(parseDecimalToCents("0.004"), 0);
  assert.equal(parseDecimalToCents("29.999"), 3000);
  assert.equal(parseDecimalToCents("999.995"), 100000);
});

test("formats minor units back to two decimals", () => {
  assert.equal(formatCents(2999), "29.99");
  assert.equal(formatCents(30), "0.30");
  assert.equal(formatCents(0), "0.00");
  assert.equal(formatCents(100000), "1000.00");
  assert.equal(formatCents(-1234), "-12.34");
});

test("percent calculation rounds half up and stays exact", () => {
  // 13.25% of $29.99 = $3.973675 -> $3.97
  assert.equal(percentOfCents(2999, 1325), 397);
  // 13.25% of $100.00 = $13.25
  assert.equal(percentOfCents(10000, 1325), 1325);
  // 13.25% of $1.00 = $0.1325 -> $0.13
  assert.equal(percentOfCents(100, 1325), 13);
  // 13.25% of $2.00 = $0.265 -> $0.27 (half up)
  assert.equal(percentOfCents(200, 1325), 27);
});

test("percent ratio is precise to two decimals of a percent", () => {
  assert.equal(percentRatioCents(1000, 4000), 2500); // 25.00%
  assert.equal(percentRatioCents(250, 10000), 250); // 2.50%
  assert.equal(percentRatioCents(0, 5000), 0); // 0.00%
  assert.equal(percentRatioCents(-1000, 4000), -2500); // -25.00%
});

test("percent ratio refuses a non-positive basis", () => {
  assert.equal(percentRatioCents(1000, 0), null);
  assert.equal(percentRatioCents(1000, -100), null);
});

test("sum ignores nulls and keeps a running total", () => {
  assert.equal(sumCents([100, null, 200]), 300);
  assert.equal(sumCents([null, null]), 0);
});
