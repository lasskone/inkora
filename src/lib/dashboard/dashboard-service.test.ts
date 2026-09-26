/**
 * Dashboard service tests — the terminal-state contract for the read path
 * (docs/ARCHITECTURE.md §19.2, §19.7).
 *
 * `loadDashboard` accepts its persistence client, so a test injects an in-memory
 * fake speaking the slice of PostgREST the repository uses — no network, no
 * credentials — and pins the one guarantee the production freeze violated:
 *
 *   - a normal load terminates and returns the whole read model;
 *   - a persisted read that **never settles** still terminates, as a degraded
 *     Dashboard whose affected sections say so, rather than a page that loads
 *     forever;
 *   - a read that throws degrades instead of failing the whole request;
 *   - one failed source costs only its own section — the rest still renders;
 *   - the read path issues exactly the seven persisted queries and calls no
 *     marketplace, supplier or freight host at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadDashboard } from "./dashboard-service";
import { DASHBOARD_READ_TIMEOUT_MS } from "./limits";

// ---------------------------------------------------------------------------
// An in-memory stand-in for PostgREST on the Dashboard's own tables
// ---------------------------------------------------------------------------

const RECENT = "2026-09-23T10:00:00.000Z";

interface TableConfig {
  rows?: Record<string, unknown>[];
  count?: number;
  /** The production failure: a request that neither resolves nor rejects. */
  hang?: boolean;
  /** A read that throws rather than answering — must degrade, not crash. */
  reject?: string;
}

/** The reasoning document the window read maps the assessment columns from. */
const ASSESSMENT = {
  marketplaceExternalId: "v1|265983500898|0",
  supplierExternalId: "cj-product-1",
  score: 72,
  confidence: 41,
  components: {
    match: { confidence: 41, confidenceBand: "LOW" },
    economics: { estimatedProfit: "8.40", marginPercent: 28.01 },
  },
  inputs: {
    competitionQuery: "wireless earbuds",
    supplierSnapshotObservedAt: RECENT,
  },
};

function windowRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "obs-1",
    marketplace_product_id: "mp-1",
    supplier_product_id: "sp-1",
    engine_version: "opportunity-v1",
    score: 72,
    score_band: "MEDIUM",
    confidence: 41,
    confidence_level: "LOW",
    match_confidence: 41,
    economics_completeness: "COMPLETE",
    calculated_at: RECENT,
    assessment: ASSESSMENT,
    marketplace_products: { external_id: "v1|265983500898|0" },
    supplier_products: { external_id: "cj-product-1" },
    ...overrides,
  };
}

function watchRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "watch-1",
    marketplace_product_id: "mp-1",
    supplier_product_id: "sp-1",
    replay_query: "wireless earbuds",
    label: null,
    created_at: "2026-09-19T10:00:00.000Z",
    updated_at: "2026-09-21T10:00:00.000Z",
    archived_at: null,
    marketplace_products: { external_id: "v1|265983500898|0" },
    supplier_products: { external_id: "cj-product-1" },
    ...overrides,
  };
}

function snapshotRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "snap-1",
    marketplace_product_id: "mp-1",
    title: "Wireless Earbuds",
    image_url: null,
    price_cents: 2999,
    currency: "USD",
    observed_at: RECENT,
    ...overrides,
  };
}

function sellerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "seller-obs-1",
    marketplace_seller_id: "seller-1",
    context_query: "wireless earbuds",
    observed_at: RECENT,
    marketplace_sellers: { external_seller_id: "seller-one", username: "Seller One" },
    ...overrides,
  };
}

/**
 * A query builder that mimics the slice of PostgREST the Dashboard repository
 * exercises: a chainable set of filters that materializes on `await`, plus the
 * two failure shapes that must never wedge the request — a hang and a throw.
 */
class FakeQuery {
  private head = false;
  private inFilter: { column: string; values: unknown[] } | null = null;
  private nullFilters: string[] = [];
  private ordering: { column: string; ascending: boolean } | null = null;
  private rowLimit: number | null = null;
  private readonly config: TableConfig;

  constructor(config: TableConfig) {
    this.config = config;
  }

  select(_columns: string, options?: { count?: string; head?: boolean }): this {
    if (options?.head === true) {
      this.head = true;
    }
    return this;
  }

  order(column: string, options: { ascending: boolean }): this {
    this.ordering = { column, ascending: options.ascending };
    return this;
  }

  limit(value: number): this {
    this.rowLimit = value;
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.inFilter = { column, values };
    return this;
  }

  is(column: string, value: null): this {
    if (value === null) {
      this.nullFilters.push(column);
    }
    return this;
  }

  then<TResult>(
    onFulfilled?: (value: unknown) => TResult | PromiseLike<TResult>,
    onRejected?: (reason: unknown) => TResult | PromiseLike<TResult>,
  ): Promise<TResult> {
    return this.materialize().then(onFulfilled, onRejected);
  }

  private materialize(): Promise<unknown> {
    if (this.config.hang === true) {
      // Intentionally never settles: this is the exact production condition.
      return new Promise<unknown>(() => {
        /* a read that never returns */
      });
    }
    if (this.config.reject !== undefined) {
      return Promise.reject(new Error(this.config.reject));
    }

    let rows = (this.config.rows ?? []).slice();
    if (this.inFilter !== null) {
      rows = rows.filter((row) =>
        this.inFilter!.values.includes(row[this.inFilter!.column] as unknown),
      );
    }
    for (const column of this.nullFilters) {
      rows = rows.filter((row) => row[column] === null || row[column] === undefined);
    }
    if (this.ordering !== null) {
      const { column, ascending } = this.ordering;
      rows.sort((a, b) => compareValues(a[column], b[column], ascending));
    }
    if (this.rowLimit !== null) {
      rows = rows.slice(0, this.rowLimit);
    }

    if (this.head === true) {
      return Promise.resolve({
        count: this.config.count ?? rows.length,
        error: null,
        data: null,
      });
    }
    return Promise.resolve({ data: rows, error: null, count: null });
  }
}

function compareValues(a: unknown, b: unknown, ascending: boolean): number {
  if (typeof a === "string" && typeof b === "string") {
    return ascending ? a.localeCompare(b) : b.localeCompare(a);
  }
  if (typeof a === "number" && typeof b === "number") {
    return ascending ? a - b : b - a;
  }
  return 0;
}

function makeFake(tables: Record<string, TableConfig>): {
  client: SupabaseClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client = {
    from(table: string): FakeQuery {
      calls.push(table);
      return new FakeQuery(tables[table] ?? {});
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

/** Every table a normal Dashboard load is permitted to read. */
const ALL_TABLES: Record<string, TableConfig> = {
  opportunity_observations: { rows: [windowRow()], count: 1 },
  watchlist_entries: { rows: [watchRow()], count: 1 },
  marketplace_product_snapshots: { rows: [snapshotRow()], count: 1 },
  marketplace_seller_observations: { rows: [sellerRow()], count: 1 },
};

// ---------------------------------------------------------------------------
// A normal load terminates and costs zero upstream budget
// ---------------------------------------------------------------------------

test("a normal load terminates and returns the whole read model", async () => {
  const { client, calls } = makeFake(ALL_TABLES);
  const started = Date.now();

  const result = await loadDashboard({
    filters: {},
    sort: "score",
    limit: 12,
    persistence: client,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.dashboard.hasIntelligence, true);
  assert.equal(result.dashboard.summary.evaluatedOpportunities, 1);
  assert.equal(result.dashboard.topOpportunities.rows.length, 1);
  assert.equal(result.dashboard.warnings.length, 0);
  // Seven bounded persisted reads, the documented worst case.
  assert.equal(calls.length, 7);
  assert.ok(Date.now() - started < 5_000);
});

test("a normal load issues exactly the seven documented persisted queries", async () => {
  const { client, calls } = makeFake(ALL_TABLES);

  await loadDashboard({ filters: {}, sort: "score", limit: 12, persistence: client });

  assert.deepEqual(
    [...calls].sort(),
    [
      "marketplace_product_snapshots",
      "marketplace_product_snapshots",
      "marketplace_seller_observations",
      "opportunity_observations",
      "opportunity_observations",
      "watchlist_entries",
      "watchlist_entries",
    ].sort(),
  );
});

test("a normal load calls no marketplace, supplier or freight host", async () => {
  const { client } = makeFake(ALL_TABLES);
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(new URL(typeof input === "string" ? input : (input as Request).url)));
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    await loadDashboard({ filters: {}, sort: "score", limit: 12, persistence: client });
  } finally {
    globalThis.fetch = originalFetch;
  }

  // The service holds no upstream port, so a normal load performs no fetch at all.
  assert.equal(requested.length, 0);
});

// ---------------------------------------------------------------------------
// The production failure: a read that never settles
// ---------------------------------------------------------------------------

test("a persisted read that hangs forever still terminates as a degraded Dashboard", { timeout: 60_000 }, async () => {
  const { client } = makeFake({
    ...ALL_TABLES,
    opportunity_observations: { hang: true },
  });

  // Termination is proved by racing the load, not by trusting the timeout
  // constant: before the fix this promise never settled and the page stayed on
  // its reading state forever.
  const raced = await Promise.race([
    loadDashboard({ filters: {}, sort: "score", limit: 12, persistence: client }),
    new Promise<{ status: string }>((resolve) =>
      setTimeout(
        () => resolve({ status: "never-terminated" }),
        DASHBOARD_READ_TIMEOUT_MS + 3_000,
      ),
    ),
  ]);

  assert.notEqual(raced.status, "never-terminated");
  assert.equal(raced.status, "degraded");
  const dashboard = (raced as {
    dashboard: {
      summary: { evaluatedOpportunities: number };
      topOpportunities: { status: string };
      warnings: string[];
    };
  }).dashboard;
  assert.equal(dashboard.summary.evaluatedOpportunities, 0);
  assert.equal(dashboard.topOpportunities.status, "unavailable");
  assert.ok(dashboard.warnings.length > 0);
});

// ---------------------------------------------------------------------------
// Failure shapes that must degrade, never crash
// ---------------------------------------------------------------------------

test("a persisted read that throws degrades its own section instead of failing the request", async () => {
  const { client } = makeFake({
    ...ALL_TABLES,
    watchlist_entries: { reject: "connection refused" },
  });

  const result = await loadDashboard({
    filters: {},
    sort: "score",
    limit: 12,
    persistence: client,
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.dashboard.hasIntelligence, true);
  assert.equal(result.dashboard.topOpportunities.rows.length, 1);
  assert.equal(result.dashboard.watchlist.status, "unavailable");
});

test("a persisted read that answers with an error degrades the same way", async () => {
  const calls: string[] = [];
  const errorClient = {
    from(table: string) {
      calls.push(table);
      return {
        select() {
          return {
            order() {
              return {
                limit() {
                  return Promise.resolve({
                    data: null,
                    error: { message: "permission denied", code: "42501" },
                  });
                },
              };
            },
            is() {
              return {
                order() {
                  return {
                    limit() {
                      return Promise.resolve({ data: null, error: { code: "42501" } });
                    },
                  };
                },
              };
            },
            in() {
              return {
                order() {
                  return {
                    limit() {
                      return Promise.resolve({ data: null, error: { code: "42501" } });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  const result = await loadDashboard({
    filters: {},
    sort: "score",
    limit: 12,
    persistence: errorClient as unknown as SupabaseClient,
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.dashboard.hasIntelligence, false);
  assert.ok(calls.length > 0);
});

test("a degraded Dashboard still answers a filtered and sorted page", { timeout: 60_000 }, async () => {
  const { client } = makeFake({
    ...ALL_TABLES,
    marketplace_seller_observations: { hang: true },
  });

  const result = await loadDashboard({
    filters: { band: "MEDIUM" },
    sort: "profit",
    limit: 6,
    persistence: client,
  });

  // The service reports the failed source as a degraded load; the page itself
  // stays usable and the applied controls are honoured.
  assert.equal(result.status, "degraded");
  assert.equal(result.dashboard.hasIntelligence, true);
  assert.equal(result.dashboard.topOpportunities.rows.length, 1);
});
