/**
 * Dashboard boundary validation tests (docs/ARCHITECTURE.md §19.6).
 *
 * The browser sends three things only — a sort key, a page size and a set of
 * filters — and each is a value from a fixed vocabulary. These pin the contract:
 * every accepted value, every rejected one, and the guarantee that a rejected
 * value names itself rather than being silently coerced into a default that
 * could hide a broken deep link.
 *
 * Pure: no database, no network, no credentials. `readDashboardQuery` builds an
 * error `Response` the route returns verbatim, so the whole boundary is
 * testable from the query string alone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BAND_VALUES,
  ECONOMICS_VALUES,
  PROFITABILITY_VALUES,
  SUPPLIER_SCOPE_VALUES,
  WATCH_STATE_VALUES,
  FilterRejectedError,
  dashboardJsonError,
  parseDashboardFilters,
  parseDashboardSortKey,
  readDashboardQuery,
} from "./dashboard-http";
import {
  DASHBOARD_DEFAULT_LIMIT,
  DASHBOARD_MAX_LIMIT,
} from "./limits";

function parse(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

test("an empty query string yields the default sort, an unfiltered page and the default limit", () => {
  const result = readDashboardQuery(new URLSearchParams());
  assert(!(result instanceof Response));
  assert.deepEqual(result.filters, {});
  assert.equal(result.sort, "score");
  assert.equal(result.limit, DASHBOARD_DEFAULT_LIMIT);
});

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

test("every documented sort key is accepted", () => {
  for (const key of [
    "score",
    "confidence",
    "profit",
    "margin",
    "match",
    "recently-evaluated",
  ] as const) {
    const result = readDashboardQuery(parse(`sort=${key}`));
    assert(!(result instanceof Response), key);
    assert.equal(result.sort, key);
  }
});

test("a sort key is trimmed, so a padded deep link still applies", () => {
  const result = readDashboardQuery(parse("sort=%20%20profit%20%20"));
  assert(!(result instanceof Response));
  assert.equal(result.sort, "profit");
});

test("an absent sort defaults to score — the engine's own verdict first", () => {
  assert.equal(parseDashboardSortKey(null), null);
  assert.equal(parseDashboardSortKey(""), null);
  assert.equal(parseDashboardSortKey("   "), null);
});

test("an unrecognized sort key is rejected, never silently re-sorted", async () => {
  for (const bad of ["score-desc", "price", "SELECT * FROM", "recently_evaluated"]) {
    const result = readDashboardQuery(parse(`sort=${encodeURIComponent(bad)}`));
    assert(result instanceof Response, bad);
    assert.equal(result.status, 400);
    const body = (await result.json()) as {
      code: string;
      detail: string;
      error: string;
    };
    assert.equal(body.code, "INVALID_SORT");
    assert.ok(body.error.includes(bad), body.error);
    assert.ok(body.detail.includes("score"), body.detail);
  }
});

// ---------------------------------------------------------------------------
// Limit — a hint, clamped server-side
// ---------------------------------------------------------------------------

test("a limit inside range is kept as an integer", () => {
  const result = readDashboardQuery(parse("limit=25"));
  assert(!(result instanceof Response));
  assert.equal(result.limit, 25);
});

test("a limit above the ceiling is clamped, not rejected", () => {
  const result = readDashboardQuery(parse("limit=5000"));
  assert(!(result instanceof Response));
  assert.equal(result.limit, DASHBOARD_MAX_LIMIT);
});

test("a limit below one is floored at one, never zero or negative", () => {
  for (const bad of ["0", "-5", "-1000"]) {
    const result = readDashboardQuery(parse(`limit=${bad}`));
    assert(!(result instanceof Response), bad);
    assert.equal(result.limit, 1);
  }
});

test("a fractional limit is truncated toward zero", () => {
  const result = readDashboardQuery(parse("limit=12.9"));
  assert(!(result instanceof Response));
  assert.equal(result.limit, 12);
});

test("an unusable limit falls back to the default rather than failing the request", () => {
  for (const bad of ["abc", "NaN", "Infinity"]) {
    const result = readDashboardQuery(parse(`limit=${encodeURIComponent(bad)}`));
    assert(!(result instanceof Response), `limit=${bad}`);
    assert.equal(result.limit, DASHBOARD_DEFAULT_LIMIT, `limit=${bad}`);
  }
});

test("an empty or blank limit is not a page size of zero: the floor applies", () => {
  // `Number("")` is 0, which is a *usable* number below the floor — so the clamp
  // lifts it to one rather than treating it as absent. A hand-edited deep link
  // with an empty limit therefore renders the smallest page, never an error and
  // never an unbounded one.
  for (const blank of ["", " "]) {
    const result = readDashboardQuery(parse(`limit=${encodeURIComponent(blank)}`));
    assert(!(result instanceof Response), `limit=${JSON.stringify(blank)}`);
    assert.equal(result.limit, 1, `limit=${JSON.stringify(blank)}`);
  }
});
// ---------------------------------------------------------------------------
// Filters — fixed vocabularies, compared for equality
// ---------------------------------------------------------------------------

test("every band, evidence and match value is accepted", () => {
  for (const value of BAND_VALUES) {
    for (const field of ["band", "evidence", "match"]) {
      const result = readDashboardQuery(parse(`${field}=${value}`));
      assert(!(result instanceof Response), `${field}=${value}`);
      assert.equal((result.filters as Record<string, string>)[field], value);
    }
  }
});

test("every economics completeness value is accepted", () => {
  for (const value of ECONOMICS_VALUES) {
    const result = readDashboardQuery(parse(`economics=${value}`));
    assert(!(result instanceof Response), value);
    assert.equal(result.filters.economics, value);
  }
});

test("every profitability value is accepted, including the honest third one", () => {
  for (const value of PROFITABILITY_VALUES) {
    const result = readDashboardQuery(parse(`profitability=${value}`));
    assert(!(result instanceof Response), value);
    assert.equal(result.filters.profitability, value);
  }
});

test("every supplier-scope and watch-state value is accepted", () => {
  for (const value of SUPPLIER_SCOPE_VALUES) {
    const result = readDashboardQuery(parse(`supplierScope=${value}`));
    assert(!(result instanceof Response), value);
    assert.equal(result.filters.supplierScope, value);
  }
  for (const value of WATCH_STATE_VALUES) {
    const result = readDashboardQuery(parse(`watchState=${value}`));
    assert(!(result instanceof Response), value);
    assert.equal(result.filters.watchState, value);
  }
});

test("all filters combine, and absent ones stay absent rather than defaulting", () => {
  const result = readDashboardQuery(
    parse(
      "band=HIGH&economics=COMPLETE&profitability=profitable&supplierScope=pair&watchState=watched&sort=profit&limit=6",
    ),
  );
  assert(!(result instanceof Response));
  assert.deepEqual(result.filters, {
    band: "HIGH",
    economics: "COMPLETE",
    profitability: "profitable",
    supplierScope: "pair",
    watchState: "watched",
  });
  assert.equal(result.sort, "profit");
  assert.equal(result.limit, 6);
});

test("a filter value is trimmed before it is compared", () => {
  const result = readDashboardQuery(parse("band=%20%20LOW%20%20"));
  assert(!(result instanceof Response));
  assert.equal(result.filters.band, "LOW");
});

test("a value outside a filter's vocabulary is rejected with field and value named", async () => {
  for (const [field, value] of [
    ["band", "high"],
    ["band", "MEDIUM; DROP TABLE"],
    ["evidence", "EXTREME"],
    ["match", "low"],
    ["economics", "FULL"],
    ["profitability", "unprofitable"],
    ["supplierScope", "any"],
    ["watchState", "archived"],
  ] as const) {
    const result = readDashboardQuery(parse(`${field}=${encodeURIComponent(value)}`));
    assert(result instanceof Response, `${field}=${value}`);
    assert.equal(result.status, 400);
    const body = (await result.json()) as {
      code: string;
      error: string;
      detail: string;
    };
    assert.equal(body.code, "INVALID_FILTER");
    assert.ok(body.error.includes(field), body.error);
    assert.ok(body.error.includes(value), body.error);
    assert.ok(body.detail.length > 0, "the error names the accepted vocabulary");
  }
});

test("a rejection names the accepted vocabulary for that field only", async () => {
  const result = readDashboardQuery(parse("economics=FULL"));
  assert(result instanceof Response);
  const body = (await result.json()) as { detail: string };
  assert.equal(body.detail, "Accepted values: COMPLETE, PARTIAL, UNAVAILABLE.");
});

test("an empty filter value is rejected, not treated as 'no filter'", async () => {
  const result = readDashboardQuery(parse("band="));
  assert(result instanceof Response);
  const body = (await result.json()) as { code: string };
  assert.equal(body.code, "INVALID_FILTER");
});

test("a filter is never a column or table name: casing and SQL do not reach a query", () => {
  for (const injected of ["score DESC", "1=1", "opportunity_observations", "*"]) {
    const result = readDashboardQuery(parse(`band=${encodeURIComponent(injected)}`));
    assert(result instanceof Response, injected);
  }
});

test("parseDashboardFilters throws the typed error the route catches", () => {
  assert.throws(
    () => parseDashboardFilters(parse("band=nope")),
    (error: unknown) =>
      error instanceof FilterRejectedError &&
      error.field === "band" &&
      error.value === "nope",
  );
});

test("an unrelated thrown error is not swallowed as a filter rejection", () => {
  class Boom extends Error {}
  const params = new URLSearchParams();
  Object.defineProperty(params, "has", {
    value: () => {
      throw new Boom();
    },
  });
  assert.throws(() => readDashboardQuery(params), Boom);
});

// ---------------------------------------------------------------------------
// Error body shape
// ---------------------------------------------------------------------------

test("the error response is no-store and carries no secret in its body", async () => {
  const response = dashboardJsonError(
    400,
    "INVALID_SORT",
    'The "sort" control does not accept "price".',
    "2026-09-25T00:00:00.000Z",
    "Accepted values: score, confidence.",
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as {
    status: string;
    code: string;
    error: string;
    timestamp: string;
    detail: string;
  };
  assert.equal(body.status, "error");
  assert.equal(body.code, "INVALID_SORT");
  assert.equal(body.timestamp, "2026-09-25T00:00:00.000Z");
  assert.ok(body.error.includes("price"));
  assert.ok(!body.error.includes("SUPABASE"));
});

test("an omitted detail is left out of the body entirely", async () => {
  const response = dashboardJsonError(
    503,
    "DASHBOARD_NOT_CONFIGURED",
    "Persistence is not configured.",
    "2026-09-25T00:00:00.000Z",
  );
  const body = (await response.json()) as { detail?: string };
  assert.equal(body.detail, undefined);
});

test("the disabled state reports variable names, never their values", async () => {
  const response = dashboardJsonError(
    503,
    "DASHBOARD_NOT_CONFIGURED",
    "Persistence is not configured on this server.",
    "2026-09-25T00:00:00.000Z",
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.",
  );
  const body = (await response.json()) as { detail: string };
  assert.ok(body.detail.includes("NEXT_PUBLIC_SUPABASE_URL"));
  const redacted = body.detail
    .replace(/NEXT_PUBLIC_SUPABASE_URL/g, "")
    .replace(/SUPABASE_SERVICE_ROLE_KEY/g, "");
  assert.ok(!/[A-Za-z0-9_\-]{20,}/.test(redacted), redacted);
});

