/**
 * Sorting and filtering tests (docs/ARCHITECTURE.md §16.9).
 *
 * Both helpers are pure, so these pin the three rules the watchlist's ordering
 * guarantees, without any database or network:
 *   1. no new score — every key orders by a transparent existing field;
 *   2. missing values have explicit semantics — an entry with no assessment
 *      sinks last under every score-derived key, and an entry with no profit
 *      matches neither profitability filter;
 *   3. the order is reproducible — the entry id is the final stable tiebreak.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { WatchlistEntryDetail } from "./types";
import { filterEntries, sortEntries, type WatchlistSortKey } from "./sorting";

const ENTRY_A = "entry-aaaaaaaa";
const ENTRY_B = "entry-bbbbbbbb";
const ENTRY_C = "entry-cccccccc";

function makeDetail(overrides: {
  id?: string;
  createdAt?: string;
  calculatedAt?: string | null;
  score?: number;
  confidence?: number;
  profit?: string | null;
  marginPercent?: number | null;
  supplierExternalId?: string | null;
  band?: "LOW" | "MEDIUM" | "HIGH";
  confidenceLevel?: "LOW" | "MEDIUM" | "HIGH";
  economicsCompleteness?: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
}): WatchlistEntryDetail {
  // An assessment exists unless the caller explicitly says it does not. Passing
  // `calculatedAt: null` is the only way to build an unassessed entry, so a test
  // that names a score or a profit always gets an assessment to put it on.
  const hasAssessment = overrides.calculatedAt !== null;
  return {
    entry: {
      id: overrides.id ?? ENTRY_A,
      marketplace: "ebay",
      marketplaceExternalId: "v1|1000000001",
      supplier: "cj",
      supplierExternalId:
        overrides.supplierExternalId === undefined ? "cj-product-1" : overrides.supplierExternalId,
      replayQuery: "anker soundcore life q30",
      label: null,
      createdAt: overrides.createdAt ?? "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    marketplace: null,
    supplier: null,
    assessment: hasAssessment
      ? {
          score: overrides.score ?? 60,
          band: overrides.band ?? "MEDIUM",
          confidence: overrides.confidence ?? 60,
          confidenceLevel: overrides.confidenceLevel ?? "MEDIUM",
          matchConfidence: 70,
          matchConfidenceBand: "MEDIUM",
          economicsCompleteness: overrides.economicsCompleteness ?? "COMPLETE",
          profit: overrides.profit === undefined ? "12.00" : overrides.profit,
          marginPercent: overrides.marginPercent === undefined ? 15 : overrides.marginPercent,
          calculatedAt: overrides.calculatedAt ?? "2026-09-10T00:00:00.000Z",
          engineVersion: "opportunity-v1",
        }
      : null,
    assessmentCount: hasAssessment ? 1 : 0,
  };
}

const DETAILS: WatchlistEntryDetail[] = [
  makeDetail({
    id: ENTRY_A,
    createdAt: "2026-09-01T00:00:00.000Z",
    calculatedAt: "2026-09-10T00:00:00.000Z",
    score: 50,
    confidence: 50,
    profit: "10.00",
    marginPercent: 12,
  }),
  makeDetail({
    id: ENTRY_B,
    createdAt: "2026-09-05T00:00:00.000Z",
    calculatedAt: "2026-09-20T00:00:00.000Z",
    score: 72,
    confidence: 72,
    band: "HIGH",
    confidenceLevel: "HIGH",
    profit: "30.00",
    marginPercent: 30,
  }),
  makeDetail({
    id: ENTRY_C,
    createdAt: "2026-09-03T00:00:00.000Z",
    calculatedAt: null,
  }),
];

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

test("score orders highest first", () => {
  const ordered = sortEntries(DETAILS, "score").map((detail) => detail.entry.id);
  assert.deepEqual(ordered, [ENTRY_B, ENTRY_A, ENTRY_C]);
});

test("profit orders highest first", () => {
  const ordered = sortEntries(DETAILS, "profit").map((detail) => detail.entry.id);
  assert.deepEqual(ordered, [ENTRY_B, ENTRY_A, ENTRY_C]);
});

test("margin orders highest first", () => {
  const ordered = sortEntries(DETAILS, "margin").map((detail) => detail.entry.id);
  assert.deepEqual(ordered, [ENTRY_B, ENTRY_A, ENTRY_C]);
});

test("confidence orders highest first, breaking ties on the score", () => {
  const equalConfidence = [
    makeDetail({ id: ENTRY_A, confidence: 60, score: 40 }),
    makeDetail({ id: ENTRY_B, confidence: 60, score: 90 }),
  ];
  const ordered = sortEntries(equalConfidence, "confidence").map((detail) => detail.entry.id);
  assert.deepEqual(ordered, [ENTRY_B, ENTRY_A]);
});

test("recently-evaluated orders by the assessment time, newest first", () => {
  const ordered = sortEntries(DETAILS, "recently-evaluated").map((detail) => detail.entry.id);
  assert.deepEqual(ordered, [ENTRY_B, ENTRY_A, ENTRY_C]);
});

test("added orders by entry creation, newest first", () => {
  const ordered = sortEntries(DETAILS, "added").map((detail) => detail.entry.id);
  assert.deepEqual(ordered, [ENTRY_B, ENTRY_C, ENTRY_A]);
});

test("an entry with no assessment sinks last under every score-derived key", () => {
  for (const key of ["score", "profit", "margin", "confidence", "recently-evaluated"] as const) {
    const ordered = sortEntries(DETAILS, key);
    assert.equal(ordered[ordered.length - 1].entry.id, ENTRY_C, `${key} sinks the unassessed entry`);
  }
});

test("the tiebreak over entry ids makes the order reproducible", () => {
  const identical = [
    makeDetail({ id: ENTRY_B, createdAt: "2026-09-01T00:00:00.000Z", calculatedAt: "2026-09-10T00:00:00.000Z", score: 50 }),
    makeDetail({ id: ENTRY_A, createdAt: "2026-09-01T00:00:00.000Z", calculatedAt: "2026-09-10T00:00:00.000Z", score: 50 }),
    makeDetail({ id: ENTRY_C, createdAt: "2026-09-01T00:00:00.000Z", calculatedAt: "2026-09-10T00:00:00.000Z", score: 50 }),
  ];

  const first = sortEntries(identical, "score").map((detail) => detail.entry.id);
  const second = sortEntries(identical, "score").map((detail) => detail.entry.id);

  assert.deepEqual(first, [ENTRY_A, ENTRY_B, ENTRY_C]);
  assert.deepEqual(first, second);
});

test("sortEntries does not mutate the input", () => {
  const original = [...DETAILS];
  sortEntries(DETAILS, "score");
  assert.deepEqual(DETAILS.map((detail) => detail.entry.id), original.map((detail) => detail.entry.id));
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test("the band filter keeps only assessments in that band", () => {
  const filtered = filterEntries(DETAILS, { band: "HIGH" });
  assert.deepEqual(filtered.map((detail) => detail.entry.id), [ENTRY_B]);
});

test("the band filter excludes an entry with no assessment", () => {
  const filtered = filterEntries(DETAILS, { band: "MEDIUM" });
  assert.deepEqual(filtered.map((detail) => detail.entry.id), [ENTRY_A]);
});

test("the confidence-level filter matches the assessment's own level", () => {
  assert.deepEqual(
    filterEntries(DETAILS, { confidenceLevel: "HIGH" }).map((detail) => detail.entry.id),
    [ENTRY_B],
  );
  assert.deepEqual(
    filterEntries(DETAILS, { confidenceLevel: "LOW" }).map((detail) => detail.entry.id),
    [],
  );
});

test("the completeness filter matches the economics completeness", () => {
  const partial = makeDetail({ id: ENTRY_C, calculatedAt: "2026-09-10T00:00:00.000Z", economicsCompleteness: "PARTIAL" });
  assert.deepEqual(
    filterEntries([partial, ...DETAILS], { completeness: "PARTIAL" }).map((detail) => detail.entry.id),
    [ENTRY_C],
  );
});

test("the profitable filter requires a recorded profit strictly greater than zero", () => {
  // `filterEntries` preserves the input order; it never re-sorts.
  const profitable = filterEntries(DETAILS, { profitability: "profitable" });
  assert.deepEqual(profitable.map((detail) => detail.entry.id), [ENTRY_A, ENTRY_B]);
});

test("the unprofitable filter keeps a recorded loss or break-even", () => {
  const loss = makeDetail({ id: ENTRY_C, calculatedAt: "2026-09-10T00:00:00.000Z", profit: "-5.00" });
  const zero = makeDetail({ id: ENTRY_B, calculatedAt: "2026-09-10T00:00:00.000Z", profit: "0.00" });

  const unprofitable = filterEntries([loss, zero], { profitability: "unprofitable" });
  assert.deepEqual(unprofitable.map((detail) => detail.entry.id), [ENTRY_C, ENTRY_B]);
});

test("an entry with no profit figure matches neither profitability filter", () => {
  // `null` is never coerced to zero: an uncosted opportunity is not pushed into
  // the unprofitable bucket, which would read as a verdict it does not have.
  const noProfit = makeDetail({ id: ENTRY_C, calculatedAt: "2026-09-10T00:00:00.000Z", profit: null });

  assert.deepEqual(filterEntries([noProfit], { profitability: "profitable" }), []);
  assert.deepEqual(filterEntries([noProfit], { profitability: "unprofitable" }), []);
});

test("the supplier-scope filter distinguishes a pair watch from a marketplace-only watch", () => {
  const pair = makeDetail({ id: ENTRY_A, supplierExternalId: "cj-product-1" });
  const marketplaceOnly = makeDetail({
    id: ENTRY_C,
    supplierExternalId: null,
    calculatedAt: null,
  });

  assert.deepEqual(
    filterEntries([pair, marketplaceOnly], { supplierScope: "pair" }).map((detail) => detail.entry.id),
    [ENTRY_A],
  );
  assert.deepEqual(
    filterEntries([pair, marketplaceOnly], { supplierScope: "marketplace-only" }).map((detail) => detail.entry.id),
    [ENTRY_C],
  );
});

test("filters compose, and an empty filter set keeps every entry", () => {
  assert.equal(filterEntries(DETAILS, {}).length, DETAILS.length);

  const filtered = filterEntries(DETAILS, { band: "HIGH", profitability: "profitable" });
  assert.deepEqual(filtered.map((detail) => detail.entry.id), [ENTRY_B]);
});

test("filterEntries does not mutate the input", () => {
  const original = [...DETAILS];
  filterEntries(DETAILS, { band: "HIGH" });
  assert.deepEqual(DETAILS.map((detail) => detail.entry.id), original.map((detail) => detail.entry.id));
});

test("every documented sort key orders the same set of entries deterministically", () => {
  const keys: WatchlistSortKey[] = [
    "recently-evaluated",
    "score",
    "profit",
    "margin",
    "confidence",
    "added",
  ];
  for (const key of keys) {
    const ordered = sortEntries(DETAILS, key);
    assert.equal(ordered.length, DETAILS.length, `${key} keeps every entry`);
    assert.deepEqual(
      [...ordered].sort((a, b) => (a.entry.id < b.entry.id ? -1 : 1)).map((detail) => detail.entry.id),
      [...DETAILS].sort((a, b) => (a.entry.id < b.entry.id ? -1 : 1)).map((detail) => detail.entry.id),
      `${key} neither drops nor invents entries`,
    );
  }
});
