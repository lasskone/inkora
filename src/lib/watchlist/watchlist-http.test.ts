/**
 * HTTP-boundary helper tests (docs/ARCHITECTURE.md §16, docs/API_INTEGRATIONS.md §5).
 *
 * These pin the boundary's own contract, independent of any database or network:
 *   - a request naming an unusable value is rejected with the reason, never
 *     silently coerced into a default;
 *   - an unrecognized filter or sort key is refused rather than ignored;
 *   - batch ids are deduped, bounded and shape-checked, because the batch cap is
 *     a cost bound and a malformed request must never widen it;
 *   - a provider configuration failure is re-labelled `not-configured` so it
 *     reports 503 (operator's fix) rather than 502 (upstream's fault).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FilterRejectedError,
  MAX_BODY_BYTES,
  parseAddInput,
  parseBatchEntryIds,
  parseDestinationOverride,
  parseFilters,
  parseSortKey,
  readWatchlistBody,
  requireProvidersConfigured,
  resolveWatchlistDestination,
  responseOutcome,
  validEntryId,
  watchlistJsonError,
} from "./watchlist-http";
import { clampWatchlistLimit, WATCHLIST_MAX_RE_EVALUATIONS } from "./limits";
import type { ReEvaluationResult } from "./types";

const NOW = "2026-09-22T00:00:00.000Z";
const ENTRY_A = "11111111-1111-1111-1111-111111111111";
const ENTRY_B = "22222222-2222-2222-2222-222222222222";
const ENTRY_C = "33333333-3333-3333-3333-333333333333";

/** A POST request carrying `body` as JSON, or no body at all when `body` is null. */
function post(body: string | null, contentType = "application/json"): Request {
  return new Request("http://localhost/api/watchlist", {
    method: "POST",
    headers: contentType === null ? undefined : { "content-type": contentType },
    body: body === null ? undefined : body,
  });
}

// ---------------------------------------------------------------------------
// Error body
// ---------------------------------------------------------------------------

test("watchlistJsonError carries the code, timestamp and a variable-name-only detail", async () => {
  const response = watchlistJsonError(
    503,
    "EBAY_NOT_CONFIGURED",
    "eBay marketplace search is not configured on this server.",
    NOW,
    "Set EBAY_ENV, EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env.local.",
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "error");
  assert.equal(body.code, "EBAY_NOT_CONFIGURED");
  assert.equal(body.timestamp, NOW);
  assert.equal(
    body.detail,
    "Set EBAY_ENV, EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env.local.",
  );
});

test("watchlistJsonError omits detail when there is nothing safe to add", async () => {
  const response = watchlistJsonError(400, "INVALID_SORT", "Unsupported sort key.", NOW);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.detail, undefined);
});

// ---------------------------------------------------------------------------
// Body reading
// ---------------------------------------------------------------------------

test("an empty body is an empty object so a payload-less endpoint stays usable", async () => {
  const parsed = await readWatchlistBody(post(null), NOW);
  assert.deepEqual(parsed, {});
});

test("a blank body is treated as an empty object too", async () => {
  const parsed = await readWatchlistBody(post("   "), NOW);
  assert.deepEqual(parsed, {});
});

test("a JSON object body is parsed and returned", async () => {
  const parsed = await readWatchlistBody(post(JSON.stringify({ sort: "score" })), NOW);
  assert.deepEqual(parsed, { sort: "score" });
});

test("a body that is not valid JSON is rejected as malformed", async () => {
  const parsed = await readWatchlistBody(post("{not json"), NOW);
  assert.ok(parsed instanceof Response);
  assert.equal(parsed.status, 400);
  const body = (await parsed.json()) as Record<string, unknown>;
  assert.equal(body.code, "MALFORMED_BODY");
});

test("a body without a JSON content type is rejected", async () => {
  const parsed = await readWatchlistBody(post(JSON.stringify({ a: 1 }), "text/plain"), NOW);
  assert.ok(parsed instanceof Response);
  assert.equal((await (parsed as Response).json()).code, "MALFORMED_BODY");
});

test("a JSON array body is rejected — the boundary accepts an object only", async () => {
  const parsed = await readWatchlistBody(post("[]"), NOW);
  assert.ok(parsed instanceof Response);
  assert.equal((await (parsed as Response).json()).code, "MALFORMED_BODY");
});

test(`a body larger than ${MAX_BODY_BYTES} bytes is rejected`, async () => {
  const parsed = await readWatchlistBody(
    post(JSON.stringify({ pad: "a".repeat(MAX_BODY_BYTES) })),
    NOW,
  );
  assert.ok(parsed instanceof Response);
  const body = (await (parsed as Response).json()) as Record<string, unknown>;
  assert.equal(body.code, "MALFORMED_BODY");
  assert.equal(parsed.status, 413);
});

// ---------------------------------------------------------------------------
// Add-input validation
// ---------------------------------------------------------------------------

test("a pair save validates both external ids and the replay query", () => {
  const input = parseAddInput({
    marketplaceExternalId: "v1|1000000001",
    supplierExternalId: "cj-product-1",
    replayQuery: "anker soundcore life q30",
  });
  assert.deepEqual(input, {
    marketplaceExternalId: "v1|1000000001",
    supplierExternalId: "cj-product-1",
    replayQuery: "anker soundcore life q30",
    label: null,
  });
});

test("an absent supplier id is a marketplace-only watch, not an error", () => {
  assert.deepEqual(
    parseAddInput({ marketplaceExternalId: "v1|1", replayQuery: "query" }),
    { marketplaceExternalId: "v1|1", supplierExternalId: null, replayQuery: "query", label: null },
  );
  assert.deepEqual(
    parseAddInput({
      marketplaceExternalId: "v1|1",
      supplierExternalId: null,
      replayQuery: "query",
    }),
    { marketplaceExternalId: "v1|1", supplierExternalId: null, replayQuery: "query", label: null },
  );
});

test("a label is carried through as optional free text", () => {
  const input = parseAddInput({
    marketplaceExternalId: "v1|1",
    supplierExternalId: "cj-1",
    replayQuery: "query",
    label: "  watch this one  ",
  });
  assert.ok(input !== null, "a complete add input must parse");
  assert.equal(input.label, "watch this one");
});

test("a save missing the marketplace id is rejected", () => {
  assert.equal(parseAddInput({ replayQuery: "query" }), null);
});

test("a save missing the replay query is rejected", () => {
  assert.equal(parseAddInput({ marketplaceExternalId: "v1|1" }), null);
});

test("an empty marketplace id is rejected, not treated as absent", () => {
  assert.equal(parseAddInput({ marketplaceExternalId: "  ", replayQuery: "query" }), null);
});

test("an unparseable supplier id is rejected rather than dropped to marketplace-only", () => {
  // A supplier id that is present but empty is a client bug, not a
  // marketplace-only watch, so it must not be silently re-interpreted.
  assert.equal(
    parseAddInput({ marketplaceExternalId: "v1|1", supplierExternalId: "", replayQuery: "query" }),
    null,
  );
});

// ---------------------------------------------------------------------------
// Sort keys and filters
// ---------------------------------------------------------------------------

test("every documented sort key is accepted and anything else is refused", () => {
  for (const key of ["recently-evaluated", "score", "profit", "margin", "confidence", "added"]) {
    assert.equal(parseSortKey(key), key);
  }
  assert.equal(parseSortKey("trend"), null);
  assert.equal(parseSortKey(""), null);
  assert.equal(parseSortKey(null), null);
  assert.equal(parseSortKey(42), null);
});

test("recognized filters are returned and echoed back", () => {
  const params = new URLSearchParams({
    band: "HIGH",
    confidenceLevel: "MEDIUM",
    completeness: "PARTIAL",
    profitability: "unprofitable",
    supplierScope: "pair",
  });

  const { filters, echo } = parseFilters(params);

  assert.deepEqual(filters, {
    band: "HIGH",
    confidenceLevel: "MEDIUM",
    completeness: "PARTIAL",
    profitability: "unprofitable",
    supplierScope: "pair",
  });
  assert.deepEqual(echo, {
    band: "HIGH",
    confidenceLevel: "MEDIUM",
    completeness: "PARTIAL",
    profitability: "unprofitable",
    supplierScope: "pair",
  });
});

test("no filter parameters means no filters and no echo", () => {
  const { filters, echo } = parseFilters(new URLSearchParams());
  assert.deepEqual(filters, {});
  assert.deepEqual(echo, {});
});

for (const [field, bad] of [
  ["band", "HGH"],
  ["confidenceLevel", "SURE"],
  ["completeness", "MOSTLY"],
  ["profitability", "break-even"],
  ["supplierScope", "any"],
] as const) {
  test(`an unrecognized ${field} filter is refused, not ignored`, () => {
    assert.throws(
      () => parseFilters(new URLSearchParams({ [field]: bad })),
      (error: unknown) =>
        error instanceof FilterRejectedError && error.field === field && error.value === bad,
    );
  });
// ---------------------------------------------------------------------------
// Batch ids
// ---------------------------------------------------------------------------

test("batch ids are returned in request order", () => {
  assert.deepEqual(parseBatchEntryIds([ENTRY_A, ENTRY_B, ENTRY_C]), [
    ENTRY_A,
    ENTRY_B,
    ENTRY_C,
  ]);
});

test("a batch containing a repeated id is rejected, not silently collapsed", () => {
  // A duplicate is a client bug, and the batch cap is a cost bound a malformed
  // request must never widen. `reevaluateBatch` dedupes as defense in depth.
  assert.equal(parseBatchEntryIds([ENTRY_A, ENTRY_A, ENTRY_B]), null);
});

test("an empty batch is rejected — the endpoint names its entries", () => {
  assert.equal(parseBatchEntryIds([]), null);
});

test("a non-array batch is rejected", () => {
  assert.equal(parseBatchEntryIds(ENTRY_A), null);
  assert.equal(parseBatchEntryIds("not-an-array"), null);
  assert.equal(parseBatchEntryIds(null), null);
  assert.equal(parseBatchEntryIds(undefined), null);
});

test(`a batch larger than ${WATCHLIST_MAX_RE_EVALUATIONS} is rejected`, () => {
  const ids = Array.from(
    { length: WATCHLIST_MAX_RE_EVALUATIONS + 1 },
    (_, index) => `${index.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`,
  );
  assert.equal(parseBatchEntryIds(ids), null);
});

test("a batch of exactly the cap is accepted", () => {
  const ids = Array.from(
    { length: WATCHLIST_MAX_RE_EVALUATIONS },
    (_, index) => `${index.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`,
  );
  assert.equal(parseBatchEntryIds(ids)?.length, WATCHLIST_MAX_RE_EVALUATIONS);
});

test("a batch containing a non-uuid is rejected wholesale", () => {
  assert.equal(parseBatchEntryIds([ENTRY_A, "not-a-uuid"]), null);
});

test("entry ids are normalized to lowercase", () => {
  assert.equal(validEntryId(ENTRY_A.toUpperCase()), ENTRY_A);
  assert.equal(validEntryId(`  ${ENTRY_A}  `), ENTRY_A);
  assert.equal(validEntryId(null), null);
  assert.equal(validEntryId(1234), null);
});

// ---------------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------------

test("no destination override resolves to the server's configured baseline", () => {
  const destination = resolveWatchlistDestination(parseDestinationOverride(undefined));
  assert.equal(destination.countryCode, "US");
  assert.equal(destination.postalCode, null);
  assert.ok(destination.label.startsWith("baseline destination"));
});

test("a null and an empty destination override both mean 'use the baseline'", () => {
  assert.equal(parseDestinationOverride(null), null);
  assert.equal(parseDestinationOverride(""), null);
  assert.equal(parseDestinationOverride(undefined), null);
});

test("a two-letter override becomes the destination country", () => {
  const destination = resolveWatchlistDestination(parseDestinationOverride("de"));
  assert.equal(destination.countryCode, "DE");
  assert.equal(destination.postalCode, null);
  assert.equal(destination.label, "requested destination DE");
});

test("an override equal to the baseline stays the baseline", () => {
  const destination = resolveWatchlistDestination(parseDestinationOverride("US"));
  assert.equal(destination.countryCode, "US");
  assert.ok(destination.label.startsWith("baseline destination"));
});

test("a malformed destination override is rejected", () => {
  assert.equal(parseDestinationOverride("usa"), null);
  assert.equal(parseDestinationOverride("1"), null);
  assert.equal(parseDestinationOverride(42), null);
});

}

// ---------------------------------------------------------------------------
// Provider configuration gate
// ---------------------------------------------------------------------------

test("the provider gate reports the missing variable by name when eBay is unconfigured", async () => {
  const saved = snapshotProviderEnv();
  clearProviderEnv();
  try {
    const response = requireProvidersConfigured(NOW);
    assert.ok(response instanceof Response);
    assert.equal(response.status, 503);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, "EBAY_NOT_CONFIGURED");
    assert.equal(body.status, "error");
    assert.ok(String(body.detail).includes("EBAY_"), "detail names the variable");
  } finally {
    restoreProviderEnv(saved);
  }
});

test("the provider gate reports CJ by name once eBay is configured", async () => {
  const saved = snapshotProviderEnv();
  process.env.EBAY_ENV = "production";
  process.env.EBAY_CLIENT_ID = "client-id";
  process.env.EBAY_CLIENT_SECRET = "client-secret";
  delete process.env.CJ_API_KEY;
  try {
    const response = requireProvidersConfigured(NOW);
    assert.ok(response instanceof Response);
    assert.equal(response.status, 503);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, "CJ_NOT_CONFIGURED");
    assert.ok(String(body.detail).includes("CJ_API_KEY"));
  } finally {
    restoreProviderEnv(saved);
  }
});

test("the provider gate allows the request through when both providers are configured", () => {
  const saved = snapshotProviderEnv();
  process.env.EBAY_ENV = "production";
  process.env.EBAY_CLIENT_ID = "client-id";
  process.env.EBAY_CLIENT_SECRET = "client-secret";
  process.env.CJ_API_KEY = "cj-key";
  try {
    assert.equal(requireProvidersConfigured(NOW), null);
  } finally {
    restoreProviderEnv(saved);
  }
});

/** Snapshots the provider variables so a test can mutate them safely. */
function snapshotProviderEnv(): Record<string, string | undefined> {
  return {
    EBAY_ENV: process.env.EBAY_ENV,
    EBAY_CLIENT_ID: process.env.EBAY_CLIENT_ID,
    EBAY_CLIENT_SECRET: process.env.EBAY_CLIENT_SECRET,
    EBAY_DEV_CLIENT_ID: process.env.EBAY_DEV_CLIENT_ID,
    EBAY_DEV_CLIENT_SECRET: process.env.EBAY_DEV_CLIENT_SECRET,
    CJ_API_KEY: process.env.CJ_API_KEY,
  };
}

function clearProviderEnv(): void {
  delete process.env.EBAY_ENV;
  delete process.env.EBAY_CLIENT_ID;
  delete process.env.EBAY_CLIENT_SECRET;
  delete process.env.EBAY_DEV_CLIENT_ID;
  delete process.env.EBAY_DEV_CLIENT_SECRET;
  delete process.env.CJ_API_KEY;
}

function restoreProviderEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Outcome re-labelling
// ---------------------------------------------------------------------------

test("a CJ configuration failure is re-labelled not-configured (503, not 502)", () => {
  const result: ReEvaluationResult = {
    entryId: ENTRY_A,
    outcome: "upstream-error",
    failureCode: "CJ_NOT_CONFIGURED",
    failureMessage: "CJdropshipping is not configured on this server.",
    assessment: null,
    comparison: null,
    evaluatedAt: NOW,
    durationMs: 12,
  };
  assert.equal(responseOutcome(result), "not-configured");
});

test("an eBay configuration failure is re-labelled not-configured too", () => {
  const result: ReEvaluationResult = {
    entryId: ENTRY_A,
    outcome: "upstream-error",
    failureCode: "EBAY_NOT_CONFIGURED",
    assessment: null,
    comparison: null,
    evaluatedAt: NOW,
    durationMs: 12,
  };
  assert.equal(responseOutcome(result), "not-configured");
});

test("a genuine upstream failure keeps its 502 outcome", () => {
  const result: ReEvaluationResult = {
    entryId: ENTRY_A,
    outcome: "upstream-error",
    failureCode: "CJ_UPSTREAM_ERROR",
    assessment: null,
    comparison: null,
    evaluatedAt: NOW,
    durationMs: 12,
  };
  assert.equal(responseOutcome(result), "upstream-error");
});

test("a verdict outcome passes through untouched", () => {
  const result: ReEvaluationResult = {
    entryId: ENTRY_A,
    outcome: "candidate-not-resolved",
    failureCode: "CANDIDATE_NOT_FOUND",
    assessment: null,
    comparison: null,
    evaluatedAt: NOW,
    durationMs: 12,
  };
  assert.equal(responseOutcome(result), "candidate-not-resolved");
});

// ---------------------------------------------------------------------------
// Limit clamping
// ---------------------------------------------------------------------------

test("an absent limit falls back to the default page size", () => {
  assert.equal(clampWatchlistLimit(undefined), 20);
});

test("an unusable limit falls back to the default page size", () => {
  assert.equal(clampWatchlistLimit(Number.NaN), 20);
  assert.equal(clampWatchlistLimit(Number.POSITIVE_INFINITY), 20);
  assert.equal(clampWatchlistLimit("twenty" as unknown as number), 20);
});

test("a limit is truncated to a whole number and floored at one", () => {
  assert.equal(clampWatchlistLimit(5.9), 5);
  assert.equal(clampWatchlistLimit(0), 1);
  assert.equal(clampWatchlistLimit(-3), 1);
});

test("a limit above the ceiling is clamped, never honoured", () => {
  assert.equal(clampWatchlistLimit(500), 50);
  assert.equal(clampWatchlistLimit(50), 50);
  assert.equal(clampWatchlistLimit(1), 1);
});
