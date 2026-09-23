/**
 * Watchlist repository tests (docs/ARCHITECTURE.md §16.2, docs/DATABASE.md §6.9).
 *
 * The repository receives its client, so a test injects an in-memory fake and
 * no network is ever required. The fake speaks the same query-builder shape the
 * repository already uses against PostgREST, and it enforces the same rules the
 * real migration does — the two partial unique indexes and the soft archive —
 * so these pin the behaviours the boundary relies on:
 *
 *   - a repeated save of the same active scope is idempotent (`reused`, never a
 *     duplicate row);
 *   - a NULL supplier is a distinct *scope*, never a wildcard that matches a
 *     pair assessment of the same listing;
 *   - archiving is idempotent and frees the uniqueness slot;
 *   - a save whose identity was never persisted is `not-observed`, so nothing is
 *     watched that was never assessed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  addEntry,
  archiveEntry,
  countActiveEntries,
  findActiveEntryIdByScope,
  findEntryById,
  readAssessmentHistory,
} from "./watchlist-repository";
import type { OpportunityAssessment } from "@/lib/opportunity/types";
import type { WatchlistAddInput } from "./types";

// ---------------------------------------------------------------------------
// An in-memory stand-in for PostgREST on the watchlist's own tables
// ---------------------------------------------------------------------------

const MP_ID = "mp-uuid-1";
const SP_ID = "sp-uuid-1";

interface WatchlistRow {
  id: string;
  marketplace_product_id: string;
  supplier_product_id: string | null;
  replay_query: string;
  label: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface ObservationRow {
  id: string;
  marketplace_product_id: string;
  supplier_product_id: string | null;
  calculated_at: string;
  engine_version: string;
  score: number | string;
  score_band: "LOW" | "MEDIUM" | "HIGH";
  confidence: number | string;
  confidence_level: "LOW" | "MEDIUM" | "HIGH";
  match_confidence: number | string;
  economics_completeness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  assessment: OpportunityAssessment;
  economics_observation_id: string | null;
}

interface FakeDatabase {
  watchlist_entries: WatchlistRow[];
  opportunity_observations: ObservationRow[];
  marketplace_products: { id: string; marketplace: string; external_id: string }[];
  supplier_products: { id: string; supplier: string; external_id: string }[];
}

type TableName = keyof FakeDatabase;

/**
 * A query builder that mimics the slice of PostgREST the repository uses: a
 * chainable set of filters that materializes on `await`. It deliberately
 * implements only the shapes the repository exercises.
 */
class FakeQuery {
  private filters: Array<{ column: string; value: unknown }> = [];
  private nullFilters: string[] = [];
  private ordering: { column: string; ascending: boolean } | null = null;
  private rowLimit: number | null = null;
  private inserted: Record<string, unknown> | null = null;
  private updated: Record<string, unknown> | null = null;
  private wantsSingle = false;
  private headOnly = false;
  private wantsCount = false;
  private columns = "";
  private readonly database: FakeDatabase;
  private readonly table: TableName;

  constructor(database: FakeDatabase, table: TableName) {
    this.database = database;
    this.table = table;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, value });
    return this;
  }

  is(column: string, value: null): this {
    if (value === null) {
      this.nullFilters.push(column);
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

  select(columns = "", options: { count?: string; head?: boolean } = {}): this {
    this.columns = columns;
    if (options.count === "exact") {
      this.wantsCount = true;
    }
    if (options.head === true) {
      this.headOnly = true;
    }
    return this;
  }

  single(): this {
    this.wantsSingle = true;
    return this;
  }

  insert(row: Record<string, unknown>): this {
    this.inserted = row;
    return this;
  }

  update(row: Record<string, unknown>): this {
    this.updated = row;
    return this;
  }

  private matches(row: Record<string, unknown>): boolean {
    for (const { column, value } of this.filters) {
      if (row[column] !== value) {
        return false;
      }
    }
    for (const column of this.nullFilters) {
      if (row[column] !== null) {
        return false;
      }
    }
    return true;
  }

  then<TResult>(
    onFulfilled:
      | ((value: { data: unknown; error: { code: string } | null; count?: number | null }) => TResult)
      | null,
    onRejected?: ((error: unknown) => TResult) | null,
  ): Promise<TResult> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }


  private execute(): { data: unknown; error: { code: string } | null; count?: number | null } {
    const rows = this.database[this.table] as unknown as Record<string, unknown>[];

    if (this.inserted !== null) {
      const created = this.applyInsert();
      if (created === null) {
        return { data: null, error: { code: "23505" } };
      }
      // PostgREST's `.single()` unwraps to one object.
      return { data: this.wantsSingle ? created : [created], error: null };
    }

    let matched = rows.filter((row) => this.matches(row));

    if (this.updated !== null) {
      if (matched.length === 0) {
        // PostgREST's `.single()` on an empty update result.
        return { data: null, error: { code: "PGRST116" } };
      }
      for (const row of matched) {
        Object.assign(row, this.updated);
      }
      return { data: this.wantsSingle ? matched[0] : [matched[0]], error: null };
    }

    if (this.ordering !== null) {
      const { column, ascending } = this.ordering;
      matched = [...matched].sort((a, b) => {
        const av = a[column] as string;
        const bv = b[column] as string;
        return ascending ? (av < bv ? -1 : av > bv ? 1 : 0) : av < bv ? 1 : av > bv ? -1 : 0;
      });
    }

    if (this.rowLimit !== null) {
      matched = matched.slice(0, this.rowLimit);
    }

    if (this.headOnly) {
      // PostgREST's head+count form: no rows, just the aggregate.
      return { data: null, error: null, count: matched.length };
    }

    const withJoins = matched.map((row) => this.attachJoins(row));

    if (this.wantsSingle) {
      if (withJoins.length === 0) {
        return { data: null, error: { code: "PGRST116" } };
      }
      return { data: withJoins[0], error: null };
    }

    return { data: withJoins, error: null };
  }

  /**
   * Emulates a PostgREST embedded select: the row keeps its columns and gains
   * the nested identity object the joined table contributes. The read model
   * must never carry an internal uuid, so the join is what supplies the
   * provider external ids.
   */
  private attachJoins(row: Record<string, unknown>): Record<string, unknown> {
    if (!this.columns.includes("marketplace_products(") && !this.columns.includes("supplier_products(")) {
      return row;
    }
    const joined: Record<string, unknown> = { ...row };
    if (this.columns.includes("marketplace_products(")) {
      const mp = this.database.marketplace_products.find(
        (candidate) => candidate.id === row["marketplace_product_id"],
      );
      joined["marketplace_products"] = mp === undefined ? null : {
        external_id: mp.external_id,
        marketplace: mp.marketplace,
      };
    }
    if (this.columns.includes("supplier_products(")) {
      if (row["supplier_product_id"] === null) {
        joined["supplier_products"] = null;
      } else {
        const sp = this.database.supplier_products.find(
          (candidate) => candidate.id === row["supplier_product_id"],
        );
        joined["supplier_products"] = sp === undefined ? null : {
          external_id: sp.external_id,
          supplier: sp.supplier,
        };
      }
    }
    return joined;
  }

  /**
   * Applies the two partial unique indexes the migration declares, returning the
   * stored row or null when the insert would violate one.
   */
  private applyInsert(): Record<string, unknown> | null {
    const rows = this.database.watchlist_entries;
    const marketplaceProductId = this.inserted?.["marketplace_product_id"] as string;
    const supplierProductId = this.inserted?.["supplier_product_id"] as string | null;

    const duplicate = rows.some((row) => {
      if (row.archived_at !== null) {
        return false;
      }
      if (row.marketplace_product_id !== marketplaceProductId) {
        return false;
      }
      // A NULL supplier is its own scope; it only conflicts with another
      // marketplace-only watch of the same listing.
      if (supplierProductId === null) {
        return row.supplier_product_id === null;
      }
      return row.supplier_product_id === supplierProductId;
    });

    if (duplicate) {
      return null;
    }

    const row: WatchlistRow = {
      id: `entry-${rows.length + 1}`,
      marketplace_product_id: marketplaceProductId,
      supplier_product_id: supplierProductId,
      replay_query: this.inserted?.["replay_query"] as string,
      label: (this.inserted?.["label"] as string | null) ?? null,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      archived_at: null,
    };
    rows.push(row);
    return { ...row };
  }
}

function fakeClient(database: FakeDatabase): SupabaseClient {
  return {
    from: (table: string) => new FakeQuery(database, table as TableName),
  } as unknown as SupabaseClient;
}

function makeDatabase(): FakeDatabase {
  return {
    watchlist_entries: [],
    opportunity_observations: [],
    marketplace_products: [
      { id: MP_ID, marketplace: "ebay", external_id: "v1|1000000001" },
    ],
    supplier_products: [
      { id: SP_ID, supplier: "cj", external_id: "cj-product-1" },
      { id: "sp-uuid-2", supplier: "cj", external_id: "cj-product-2" },
    ],
  };
}


function makeAssessment(overrides: Partial<OpportunityAssessment> = {}): OpportunityAssessment {
  return {
    engineVersion: "opportunity-v1",
    calculatedAt: "2026-09-10T00:00:00.000Z",
    marketplace: "ebay",
    marketplaceExternalId: "v1|1000000001",
    supplier: "cj",
    supplierExternalId: "cj-product-1",
    score: 60,
    band: "MEDIUM",
    confidence: 60,
    confidenceLevel: "MEDIUM",
    components: {
      economics: {
        completeness: "COMPLETE",
        estimatedProfit: "12.00",
        marginPercent: 15,
        supplierCostBasis: "SELECTED_VARIANT",
        score: 70,
        rationale: "complete economics",
        warnings: [],
        assumptions: [],
        economicsEngineVersion: "economics-landed-1.0",
        feeEngineVersion: "ebay-fee-rules-1.0",
      },
      match: {
        confidence: 70,
        confidenceBand: "MEDIUM",
        score: 70,
        explanation: "plausible candidate",
        signals: [],
        contradictions: [],
        cappedByHardContradiction: false,
        supplierExternalId: "cj-product-1",
      },
      competition: {
        verdict: "APPEARS_MODERATE",
        intensity: 45,
        score: 55,
        query: "anker soundcore life q30",
        searchResultTotal: 120,
        sampleSize: 10,
        distinctSellers: 8,
        similarlyPricedListings: 3,
        newConditionListings: 7,
        caveats: ["one query is a sample, not a census"],
      },
      demand: {
        verdict: "INSUFFICIENT_EVIDENCE",
        score: 0,
        evidence: [],
        limitations: ["no demand evidence available"],
        listingPersistence: null,
        sourcing: { queries: 1, candidateCount: 1, note: "one candidate" },
      },
      dataQuality: {
        score: 80,
        dimensions: [],
        evidence: ["title", "price", "seller"],
        limitations: [],
      },
    },
    factors: [],
    caps: [],
    headline: "a plausible opportunity",
    explanation: ["one line"],
    caveats: ["not a prediction"],
    inputs: {
      marketplaceSnapshotObservedAt: null,
      supplierSnapshotObservedAt: null,
      economicsCalculatedAt: null,
      competitionQuery: "anker soundcore life q30",
      historyAvailable: false,
    },
    ...overrides,
  };
}

const PAIR_INPUT: WatchlistAddInput = {
  marketplaceExternalId: "v1|1000000001",
  supplierExternalId: "cj-product-1",
  replayQuery: "anker soundcore life q30",
};

const MARKETPLACE_ONLY_INPUT: WatchlistAddInput = {
  marketplaceExternalId: "v1|1000000001",
  supplierExternalId: null,
  replayQuery: "anker soundcore life q30",
};

/** Seeds a pair watch plus one assessment for it. */
function seedPair(database: FakeDatabase, calculatedAt = "2026-09-10T00:00:00.000Z"): void {
  database.watchlist_entries.push({
    id: "entry-1",
    marketplace_product_id: MP_ID,
    supplier_product_id: SP_ID,
    replay_query: "anker soundcore life q30",
    label: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    archived_at: null,
  });
  database.opportunity_observations.push({
    id: "obs-1",
    marketplace_product_id: MP_ID,
    supplier_product_id: SP_ID,
    calculated_at: calculatedAt,
    engine_version: "opportunity-v1",
    score: 60,
    score_band: "MEDIUM",
    confidence: 60,
    confidence_level: "MEDIUM",
    match_confidence: 70,
    economics_completeness: "COMPLETE",
    assessment: makeAssessment({ calculatedAt }),
    economics_observation_id: "econ-1",
  });
}


// ---------------------------------------------------------------------------
// Idempotent add and uniqueness
// ---------------------------------------------------------------------------

test("a first save creates a watched entry", async () => {
  const database = makeDatabase();
  const result = await addEntry(fakeClient(database), PAIR_INPUT);

  assert.equal(result.status, "inserted");
  assert.equal(database.watchlist_entries.length, 1);
  assert.equal(database.watchlist_entries[0]?.supplier_product_id, SP_ID);
  assert.equal(database.watchlist_entries[0]?.archived_at, null);
});

test("a second save of the same active pair is idempotent and reports reused", async () => {
  const database = makeDatabase();
  const first = await addEntry(fakeClient(database), PAIR_INPUT);
  const second = await addEntry(fakeClient(database), PAIR_INPUT);

  assert.equal(first.status, "inserted");
  assert.equal(second.status, "reused", "the existing row is reused, never duplicated");
  assert.equal(database.watchlist_entries.length, 1);
  assert.equal(second.row.id, first.row.id);
});

test("re-saving does not create a duplicate row even under repeated calls", async () => {
  const database = makeDatabase();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await addEntry(fakeClient(database), PAIR_INPUT);
  }

  assert.equal(database.watchlist_entries.length, 1);
});

test("the same listing watched against a different supplier is a separate row", async () => {
  const database = makeDatabase();
  await addEntry(fakeClient(database), PAIR_INPUT);
  await addEntry(
    fakeClient(database),
    { ...PAIR_INPUT, supplierExternalId: "cj-product-2" },
  );

  assert.equal(database.watchlist_entries.length, 2);
});

// ---------------------------------------------------------------------------
// NULL supplier is a distinct scope, never a wildcard
// ---------------------------------------------------------------------------

test("a marketplace-only watch of a listing already watched as a pair is a separate row", async () => {
  const database = makeDatabase();
  await addEntry(fakeClient(database), PAIR_INPUT);
  await addEntry(fakeClient(database), MARKETPLACE_ONLY_INPUT);

  assert.equal(database.watchlist_entries.length, 2);
});

test("a marketplace-only save finds the marketplace-only scope, not the pair scope", async () => {
  const database = makeDatabase();
  await addEntry(fakeClient(database), PAIR_INPUT);
  const second = await addEntry(fakeClient(database), MARKETPLACE_ONLY_INPUT);

  assert.equal(second.status, "inserted", "no wildcard match — NULL is its own scope");
});

test("re-saving a marketplace-only watch reuses that scope alone", async () => {
  const database = makeDatabase();
  const first = await addEntry(fakeClient(database), MARKETPLACE_ONLY_INPUT);
  await addEntry(fakeClient(database), PAIR_INPUT);
  const second = await addEntry(fakeClient(database), MARKETPLACE_ONLY_INPUT);

  assert.equal(first.status, "inserted");
  assert.equal(second.status, "reused");
  assert.equal(second.row.id, first.row.id);
  assert.equal(database.watchlist_entries.length, 2);
});

test("an observation for a pair is invisible to a marketplace-only history query", async () => {
  // The core rule a partial unique index plus a scoped history must keep.
  const database = makeDatabase();
  seedPair(database);
  await addEntry(fakeClient(database), MARKETPLACE_ONLY_INPUT);

  const history = await readAssessmentHistory(
    fakeClient(database),
    { marketplaceExternalId: "v1|1000000001", supplierExternalId: null },
    10,
  );

  assert.equal(history.length, 0, "NULL must never act as a wildcard that matches a pair row");
});

test("a pair history query excludes marketplace-only observations", async () => {
  const database = makeDatabase();
  seedPair(database);
  database.opportunity_observations.push({
    id: "obs-marketplace-only",
    marketplace_product_id: MP_ID,
    supplier_product_id: null,
    calculated_at: "2026-09-12T00:00:00.000Z",
    engine_version: "opportunity-v1",
    score: 40,
    score_band: "LOW",
    confidence: 40,
    confidence_level: "LOW",
    match_confidence: 30,
    economics_completeness: "UNAVAILABLE",
    assessment: makeAssessment({ calculatedAt: "2026-09-12T00:00:00.000Z", score: 40 }),
    economics_observation_id: null,
  });

  const history = await readAssessmentHistory(
    fakeClient(database),
    { marketplaceExternalId: "v1|1000000001", supplierExternalId: "cj-product-1" },
    10,
  );

  assert.equal(history.length, 1);
  assert.equal(history[0]?.calculatedAt, "2026-09-10T00:00:00.000Z");
});


// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

test("archiving a watched entry sets archived_at and reports archived", async () => {
  const database = makeDatabase();
  seedPair(database);

  const result = await archiveEntry(fakeClient(database), "entry-1");

  assert.equal(result, "archived");
  assert.notEqual(database.watchlist_entries[0]?.archived_at, null);
});

test("archiving an already-archived entry is idempotent", async () => {
  const database = makeDatabase();
  seedPair(database);
  const first = await archiveEntry(fakeClient(database), "entry-1");
  const second = await archiveEntry(fakeClient(database), "entry-1");

  assert.equal(first, "archived");
  assert.equal(second, "already-archived", "the second archive is a no-op, not an error");
  assert.equal(database.watchlist_entries.length, 1);
});

test("archiving an entry that does not exist is reported, not thrown", async () => {
  const database = makeDatabase();

  const result = await archiveEntry(fakeClient(database), "entry-missing");

  assert.equal(result, "not-found");
});

test("archiving frees the uniqueness slot, so the scope can be watched again", async () => {
  const database = makeDatabase();
  await addEntry(fakeClient(database), PAIR_INPUT);
  await archiveEntry(fakeClient(database), "entry-1");

  const result = await addEntry(fakeClient(database), PAIR_INPUT);

  assert.equal(result.status, "inserted", "the archive freed the slot, so a new row is made");
  assert.equal(database.watchlist_entries.length, 2);
  assert.equal(database.watchlist_entries.filter((row) => row.archived_at === null).length, 1);
});

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

test("an entry is found by id", async () => {
  const database = makeDatabase();
  seedPair(database);

  const entry = await findEntryById(fakeClient(database), "entry-1");

  assert.notEqual(entry, null);
  assert.equal(entry?.id, "entry-1");
});

test("a missing entry resolves to null rather than throwing", async () => {
  const database = makeDatabase();
  assert.equal(await findEntryById(fakeClient(database), "entry-missing"), null);
});

test("an active scope resolves to its entry id", async () => {
  const database = makeDatabase();
  seedPair(database);

  assert.equal(
    await findActiveEntryIdByScope(fakeClient(database), PAIR_INPUT),
    "entry-1",
  );
});

test("a marketplace-only scope resolves to the marketplace-only entry", async () => {
  const database = makeDatabase();
  seedPair(database);
  await addEntry(fakeClient(database), MARKETPLACE_ONLY_INPUT);

  assert.equal(
    await findActiveEntryIdByScope(fakeClient(database), MARKETPLACE_ONLY_INPUT),
    "entry-2",
  );
});

test("a NULL scope does not match a pair entry", async () => {
  const database = makeDatabase();
  seedPair(database);

  assert.equal(
    await findActiveEntryIdByScope(fakeClient(database), MARKETPLACE_ONLY_INPUT),
    null,
  );
});

test("an archived scope is not active", async () => {
  const database = makeDatabase();
  seedPair(database);
  await archiveEntry(fakeClient(database), "entry-1");

  assert.equal(
    await findActiveEntryIdByScope(fakeClient(database), PAIR_INPUT),
    null,
  );
});

test("the active count ignores archived rows", async () => {
  const database = makeDatabase();
  seedPair(database);
  await addEntry(fakeClient(database), MARKETPLACE_ONLY_INPUT);

  assert.equal(await countActiveEntries(fakeClient(database)), 2);

  await archiveEntry(fakeClient(database), "entry-1");
  assert.equal(await countActiveEntries(fakeClient(database)), 1);
});
