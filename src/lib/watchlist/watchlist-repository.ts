/**
 * Watchlist V1 repository — the only server-only code path that touches
 * `watchlist_entries` (docs/ARCHITECTURE.md §16.2, docs/DATABASE.md §6.9).
 *
 * The repository is deliberately thin and deliberately *not* a domain service:
 * it stores and reads monitoring intent, maps rows to provider-identity read
 * models, and nothing else. It never scores, never matches, never prices, and it
 * never cascades — archiving an entry touches exactly one row and leaves every
 * observation table alone (docs/ARCHITECTURE.md §16.6).
 *
 * Conventions follow the persistence layer exactly (docs/DATABASE.md):
 *   - every function receives the client, so a test can inject a fake and no
 *     network is ever required;
 *   - writes report the PostgREST error code rather than throwing, so the route
 *     can translate it into its own vocabulary;
 *   - reads are always bounded and most-recent-first;
 *   - a NULL `supplier_product_id` is a *scope* (`IS NULL`), never a value.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MarketplaceId } from "@/lib/marketplace/types";
import type { SupplierId } from "@/lib/supplier/types";
import { numericToNumber, centsToDecimalOrNull } from "@/lib/persistence/mapping";
import type { OpportunityAssessment } from "@/lib/opportunity/types";

import type {
  ComparisonMoney,
  PreviousObservation,
  WatchlistAddInput,
  WatchlistAssessmentInfo,
  WatchlistEntry,
  WatchlistHistoryEntry,
  WatchlistMarketplaceInfo,
  WatchlistSupplierInfo,
} from "./types";

/** The only marketplace with an adapter today (docs/ARCHITECTURE.md §4). */
const MARKETPLACE: MarketplaceId = "ebay";

/** The only supplier with an adapter today (docs/ARCHITECTURE.md §4.2). */
const SUPPLIER: SupplierId = "cj";

/** `watchlist_entries` row. */
export interface WatchlistEntryRow {
  id: string;
  marketplace_product_id: string;
  supplier_product_id: string | null;
  replay_query: string;
  label: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** Shape of the joined identity read the list/find queries perform. */
interface EntryRowWithIdentity extends WatchlistEntryRow {
  marketplace_products: { external_id: string; marketplace: string } | { external_id: string; marketplace: string }[] | null;
  supplier_products: { external_id: string; supplier: string } | { external_id: string; supplier: string }[] | null;
}

/**
 * PostgREST embeds a to-one relationship as an object, but its exact shape is
 * not worth trusting across versions, so both spellings are accepted — the same
 * defensive reading `history-reader.ts` applies.
 */
function joined<T>(value: T | T[] | null): T | null {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value;
}

/** Maps a joined entry row to the provider-identity read model the API speaks. */
export function entryRowToReadModel(row: EntryRowWithIdentity): WatchlistEntry {
  const marketplace = joined(row.marketplace_products);
  const supplier = joined(row.supplier_products);
  return {
    id: row.id,
    marketplace: MARKETPLACE,
    marketplaceExternalId: marketplace?.external_id ?? "",
    supplier: supplier === null ? null : SUPPLIER,
    supplierExternalId: supplier?.external_id ?? null,
    replayQuery: row.replay_query,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


/**
 * Outcome of a save attempt.
 *
 *   inserted       — a new active entry was created.
 *   reused         — an identical active entry already existed; the save was
 *                    idempotent and returned it (docs/ARCHITECTURE.md §16.5).
 *   not-observed   — the marketplace or supplier identity has never been
 *                    persisted, so there is nothing legitimate to watch. The
 *                    caller reports this rather than creating an entry.
 *   failed         — the database rejected the write; `code` is the PostgREST
 *                    code, safe to surface.
 */
export type AddEntryResult =
  | { status: "inserted"; row: WatchlistEntryRow }
  | { status: "reused"; row: WatchlistEntryRow }
  | { status: "not-observed"; which: "marketplace" | "supplier" }
  | { status: "failed"; code: string };

/**
 * Adds a watchlist entry, idempotently.
 *
 * The entry is keyed by internal identity resolved from the *provider external
 * ids* — the browser never sends an internal uuid — and a repeated save of the
 * same active scope returns the existing row instead of duplicating it. The two
 * partial unique indexes (docs/DATABASE.md §6.9) make the NULL-supplier scope a
 * distinct watch rather than a wildcard.
 */
export async function addEntry(
  client: SupabaseClient,
  input: WatchlistAddInput,
): Promise<AddEntryResult> {
  const marketplaceProductId = await findMarketplaceProductId(client, input.marketplaceExternalId);
  if (marketplaceProductId === null) {
    return { status: "not-observed", which: "marketplace" };
  }

  let supplierProductId: string | null = null;
  if (input.supplierExternalId !== null && input.supplierExternalId !== undefined) {
    supplierProductId = await findSupplierProductId(client, input.supplierExternalId);
    if (supplierProductId === null) {
      return { status: "not-observed", which: "supplier" };
    }
  }

  const insert = {
    marketplace_product_id: marketplaceProductId,
    supplier_product_id: supplierProductId,
    replay_query: input.replayQuery,
    label: input.label ?? null,
  };

  const { data, error } = await client
    .from("watchlist_entries")
    .insert(insert)
    .select("*")
    .single();

  if (error !== null) {
    if (error.code === "23505") {
      // The unique index rejected a duplicate active scope: return the existing
      // entry so a repeated save is a no-op rather than an error.
      const existing = await findActiveEntryByScope(client, {
        marketplaceProductId,
        supplierProductId,
      });
      if (existing !== null) {
        return { status: "reused", row: existing };
      }
    }
    return { status: "failed", code: error.code };
  }

  if (data === null) {
    return { status: "failed", code: "no-row-returned" };
  }

  return { status: "inserted", row: data as WatchlistEntryRow };
}

/**
 * Archives one entry: sets `archived_at` and bumps `updated_at`. Soft by design
 * — the row is retained so the monitoring-intent history stays auditable, and no
 * observation row is ever touched (docs/ARCHITECTURE.md §16.6).
 *
 * Returns `archived` when an active row was archived, `already-archived` when the
 * entry was already archived, and `not-found` when no such entry exists.
 */
export async function archiveEntry(
  client: SupabaseClient,
  id: string,
): Promise<"archived" | "already-archived" | "not-found" | "failed"> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("watchlist_entries")
    .update({ archived_at: now, updated_at: now })
    .eq("id", id)
    .is("archived_at", null)
    .select("id")
    .single();

  if (error !== null) {
    if (error.code === "PGRST116") {
      // No row matched the active filter: the entry is absent or already archived.
      const { data: rows } = await client
        .from("watchlist_entries")
        .select("archived_at")
        .eq("id", id)
        .limit(1);
      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0].archived_at === null ? "failed" : "already-archived";
      }
      return "not-found";
    }
    return "failed";
  }

  if (data === null) {
    return "not-found";
  }

  return "archived";
}

/** Stable marketplace identity lookup by provider + external id. */
async function findMarketplaceProductId(
  client: SupabaseClient,
  externalId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("marketplace_products")
    .select("id")
    .eq("marketplace", MARKETPLACE)
    .eq("external_id", externalId)
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }
  return (data[0] as { id: string }).id;
}

/** Stable supplier identity lookup by external id. */
async function findSupplierProductId(
  client: SupabaseClient,
  externalId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("supplier_products")
    .select("id")
    .eq("external_id", externalId)
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }
  return (data[0] as { id: string }).id;
}

/**
 * Finds the active entry for one uniqueness scope — used to satisfy an
 * idempotent save after the unique index reports a duplicate.
 */
async function findActiveEntryByScope(
  client: SupabaseClient,
  scope: { marketplaceProductId: string; supplierProductId: string | null },
): Promise<WatchlistEntryRow | null> {
  let query = client
    .from("watchlist_entries")
    .select("*")
    .eq("marketplace_product_id", scope.marketplaceProductId)
    .is("archived_at", null)
    .limit(1);

  if (scope.supplierProductId !== null) {
    query = query.eq("supplier_product_id", scope.supplierProductId);
  } else {
    query = query.is("supplier_product_id", null);
  }

  const { data, error } = await query;
  if (error !== null || data === null || data.length === 0) {
    return null;
  }
  return data[0] as WatchlistEntryRow;
}

/**
 * Resolves an add request's external ids to the active entry already watching
 * that scope, or `null` when the scope is not watched.
 *
 * The route uses this when the entry cap is reached: a scope that is already
 * watched is still reported as `reused` — a repeated save is always a success —
 * while a genuinely new scope is refused with `WATCHLIST_FULL`.
 */
export async function findActiveEntryIdByScope(
  client: SupabaseClient,
  input: WatchlistAddInput,
): Promise<string | null> {
  const marketplaceProductId = await findMarketplaceProductId(client, input.marketplaceExternalId);
  if (marketplaceProductId === null) {
    return null;
  }
  const supplierProductId =
    input.supplierExternalId === null || input.supplierExternalId === undefined
      ? null
      : await findSupplierProductId(client, input.supplierExternalId);
  if (input.supplierExternalId !== null && input.supplierExternalId !== undefined && supplierProductId === null) {
    return null;
  }

  const existing = await findActiveEntryByScope(client, { marketplaceProductId, supplierProductId });
  return existing === null ? null : existing.id;
}


/**
 * Counts active entries — the guard behind the entry cap
 * (docs/ARCHITECTURE.md §16.3). A head count is all the route needs to decide
 * whether a new entry fits, so this stays a cheap aggregate instead of pulling
 * rows. Unavailable persistence is reported as zero, which the route already
 * refuses before it gets here.
 */
export async function countActiveEntries(client: SupabaseClient): Promise<number> {
  const { count, error } = await client
    .from("watchlist_entries")
    .select("id", { count: "exact", head: true })
    .is("archived_at", null);

  if (error !== null || count === null) {
    return 0;
  }
  return count;
}



/**
 * Lists active entries, most recently added first, bounded — the read behind the
 * watchlist page (docs/ARCHITECTURE.md §16.3). External ids come from the joined
 * identity tables, so the read model never carries an internal uuid.
 */
export async function listEntries(
  client: SupabaseClient,
  params: { limit: number },
): Promise<WatchlistEntry[]> {
  const { data, error } = await client
    .from("watchlist_entries")
    .select(
      "id, marketplace_product_id, supplier_product_id, replay_query, label, created_at, updated_at, archived_at, marketplace_products(external_id, marketplace), supplier_products(external_id, supplier)",
    )
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(params.limit);

  if (error !== null || data === null) {
    return [];
  }

  return (data as EntryRowWithIdentity[]).map(entryRowToReadModel);
}

/**
 * Reads one entry by id with its joined identities, or `null` when it does not
 * exist. Archived entries are returned — the route decides whether to refuse.
 */
export async function findEntryById(
  client: SupabaseClient,
  id: string,
): Promise<(WatchlistEntry & { archivedAt: string | null }) | null> {
  const { data, error } = await client
    .from("watchlist_entries")
    .select(
      "id, marketplace_product_id, supplier_product_id, replay_query, label, created_at, updated_at, archived_at, marketplace_products(external_id, marketplace), supplier_products(external_id, supplier)",
    )
    .eq("id", id)
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }

  const row = data[0] as EntryRowWithIdentity;
  return { ...entryRowToReadModel(row), archivedAt: row.archived_at };
}

/** Shape of the latest-assessment read: the summary columns plus the full document. */
export interface LatestAssessmentRow {
  id: string;
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

/**
 * Reads the most recent persisted assessment for one entry's scope.
 *
 * A NULL `supplier_product_id` is a *scope*: marketplace-only entries read the
 * latest no-supplier assessment, never a pair assessment of the same listing
 * (docs/DATABASE.md §6.9).
 */
export async function readLatestAssessment(
  client: SupabaseClient,
  scope: { marketplaceExternalId: string; supplierExternalId: string | null },
): Promise<LatestAssessmentRow | null> {
  const marketplaceProductId = await findMarketplaceProductId(client, scope.marketplaceExternalId);
  if (marketplaceProductId === null) {
    return null;
  }

  let query = client
    .from("opportunity_observations")
    .select(
      "id, calculated_at, engine_version, score, score_band, confidence, confidence_level, match_confidence, economics_completeness, assessment, economics_observation_id",
    )
    .eq("marketplace_product_id", marketplaceProductId)
    .order("calculated_at", { ascending: false })
    .limit(1);

  if (scope.supplierExternalId !== null) {
    const supplierProductId = await findSupplierProductId(client, scope.supplierExternalId);
    if (supplierProductId === null) {
      return null;
    }
    query = query.eq("supplier_product_id", supplierProductId);
  } else {
    query = query.is("supplier_product_id", null);
  }

  const { data, error } = await query;
  if (error !== null || data === null || data.length === 0) {
    return null;
  }
  return data[0] as LatestAssessmentRow;
}

/**
 * Counts the persisted assessments for one entry's scope. Zero is a valid
 * answer: an entry can be watched before any assessment exists for its scope.
 */
export async function countAssessments(
  client: SupabaseClient,
  scope: { marketplaceExternalId: string; supplierExternalId: string | null },
): Promise<number> {
  const marketplaceProductId = await findMarketplaceProductId(client, scope.marketplaceExternalId);
  if (marketplaceProductId === null) {
    return 0;
  }

  let query = client
    .from("opportunity_observations")
    .select("id", { count: "exact", head: true })
    .eq("marketplace_product_id", marketplaceProductId);

  if (scope.supplierExternalId !== null) {
    const supplierProductId = await findSupplierProductId(client, scope.supplierExternalId);
    if (supplierProductId === null) {
      return 0;
    }
    query = query.eq("supplier_product_id", supplierProductId);
  } else {
    query = query.is("supplier_product_id", null);
  }

  const { count, error } = await query;
  if (error !== null || count === null) {
    return 0;
  }
  return count;
}

/**
 * Maps a stored assessment row to the card's last-known assessment info. Every
 * figure comes from the persisted document — nothing is recomputed, nothing is
 * guessed, and profit/margin may legitimately be absent.
 */
export function assessmentRowToInfo(row: LatestAssessmentRow): WatchlistAssessmentInfo {
  const assessment = row.assessment;
  return {
    score: numericToNumber(row.score) ?? 0,
    band: row.score_band,
    confidence: numericToNumber(row.confidence) ?? 0,
    confidenceLevel: row.confidence_level,
    matchConfidence: numericToNumber(row.match_confidence) ?? 0,
    matchConfidenceBand: assessment.components.match.confidenceBand,
    economicsCompleteness: row.economics_completeness,
    profit: assessment.components.economics.estimatedProfit,
    marginPercent: assessment.components.economics.marginPercent,
    calculatedAt: row.calculated_at,
    engineVersion: row.engine_version,
  };
}

/** Maps a stored assessment row to one bounded timeline entry. */
export function observationRowToHistoryEntry(row: LatestAssessmentRow): WatchlistHistoryEntry {
  const assessment = row.assessment;
  return {
    calculatedAt: row.calculated_at,
    score: numericToNumber(row.score) ?? 0,
    band: row.score_band,
    confidence: numericToNumber(row.confidence) ?? 0,
    confidenceLevel: row.confidence_level,
    economicsCompleteness: row.economics_completeness,
    profit: assessment.components.economics.estimatedProfit,
    marginPercent: assessment.components.economics.marginPercent,
    matchConfidence: numericToNumber(row.match_confidence) ?? 0,
    engineVersion: row.engine_version,
    caveats: assessment.caveats,
  };
}



/**
 * Bounded assessment timeline for one entry's scope, newest first. Every entry
 * is explicitly historical — none of them is a statement about the listing's
 * current price or stock (docs/ARCHITECTURE.md §16.8).
 */
export async function readAssessmentHistory(
  client: SupabaseClient,
  scope: { marketplaceExternalId: string; supplierExternalId: string | null },
  limit: number,
): Promise<WatchlistHistoryEntry[]> {
  const marketplaceProductId = await findMarketplaceProductId(client, scope.marketplaceExternalId);
  if (marketplaceProductId === null) {
    return [];
  }

  let query = client
    .from("opportunity_observations")
    .select(
      "calculated_at, score, score_band, confidence, confidence_level, match_confidence, economics_completeness, assessment, engine_version",
    )
    .eq("marketplace_product_id", marketplaceProductId)
    .order("calculated_at", { ascending: false })
    .limit(limit);

  if (scope.supplierExternalId !== null) {
    const supplierProductId = await findSupplierProductId(client, scope.supplierExternalId);
    if (supplierProductId === null) {
      return [];
    }
    query = query.eq("supplier_product_id", supplierProductId);
  } else {
    query = query.is("supplier_product_id", null);
  }

  const { data, error } = await query;
  if (error !== null || data === null) {
    return [];
  }

  return (data as LatestAssessmentRow[]).map(observationRowToHistoryEntry);
}

/** Latest stored marketplace snapshot for a listing (title, image, price). */
export async function readLatestMarketplaceSnapshot(
  client: SupabaseClient,
  marketplaceExternalId: string,
): Promise<WatchlistMarketplaceInfo | null> {
  const marketplaceProductId = await findMarketplaceProductId(client, marketplaceExternalId);
  if (marketplaceProductId === null) {
    return null;
  }

  const { data, error } = await client
    .from("marketplace_product_snapshots")
    .select("title, image_url, listing_url, price_cents, currency, observed_at")
    .eq("marketplace_product_id", marketplaceProductId)
    .order("observed_at", { ascending: false })
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }

  const row = data[0] as {
    title: string;
    image_url: string | null;
    listing_url: string | null;
    price_cents: number | string | null;
    currency: string | null;
    observed_at: string;
  };

  return {
    title: row.title,
    imageUrl: row.image_url,
    listingUrl: row.listing_url,
    price: centsToDecimalOrNull(numericToNumber(row.price_cents)),
    currency: row.currency,
    observedAt: row.observed_at,
  };
}

/** Latest stored supplier snapshot for a pair watch (title, image, reference cost). */
export async function readLatestSupplierSnapshot(
  client: SupabaseClient,
  supplierExternalId: string,
): Promise<WatchlistSupplierInfo | null> {
  const supplierProductId = await findSupplierProductId(client, supplierExternalId);
  if (supplierProductId === null) {
    return null;
  }

  const { data, error } = await client
    .from("supplier_product_snapshots")
    .select("title, image_url, catalog_reference_price_cents, currency, observed_at")
    .eq("supplier_product_id", supplierProductId)
    .order("observed_at", { ascending: false })
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }

  const row = data[0] as {
    title: string;
    image_url: string | null;
    catalog_reference_price_cents: number | string | null;
    currency: string | null;
    observed_at: string;
  };

  return {
    title: row.title,
    imageUrl: row.image_url,
    referenceCost: centsToDecimalOrNull(numericToNumber(row.catalog_reference_price_cents)),
    currency: row.currency,
    observedAt: row.observed_at,
  };
}

/** Shape of the linked economics observation read for a comparison. */
interface EconomicsMoneyRow {
  item_price_cents: number | string | null;
  supplier_product_cost_cents: number | string | null;
  supplier_shipping_cents: number | string | null;
  landed_cost_cents: number | string | null;
  estimated_profit_cents: number | string | null;
  margin_percent_cents: number | string | null;
}

/** Reads the money fields of the economics observation an assessment links to. */
async function readLinkedEconomics(
  client: SupabaseClient,
  economicsObservationId: string | null,
): Promise<ComparisonMoney | null> {
  if (economicsObservationId === null) {
    return null;
  }

  const { data, error } = await client
    .from("economics_observations")
    .select(
      "item_price_cents, supplier_product_cost_cents, supplier_shipping_cents, landed_cost_cents, estimated_profit_cents, margin_percent_cents",
    )
    .eq("id", economicsObservationId)
    .limit(1);

  if (error !== null || data === null || data.length === 0) {
    return null;
  }

  const row = data[0] as EconomicsMoneyRow;
  const marginPercentCents = numericToNumber(row.margin_percent_cents);
  return {
    marketplacePriceCents: numericToNumber(row.item_price_cents),
    supplierCostCents: numericToNumber(row.supplier_product_cost_cents),
    supplierShippingCents: numericToNumber(row.supplier_shipping_cents),
    landedCostCents: numericToNumber(row.landed_cost_cents),
    estimatedProfitCents: numericToNumber(row.estimated_profit_cents),
    marginPercent: marginPercentCents === null ? null : marginPercentCents / 100,
  };
}

/**
 * Reads the immediately previous observation for an entry's scope: the latest
 * assessment plus the money fields of the economics observation it linked to.
 *
 * This is what a re-evaluation compares against, and it is read **before** the
 * new assessment is persisted, so a fresh assessment never counts itself as its
 * own prior (docs/ARCHITECTURE.md §9.8, §16.8). `null` means no prior exists.
 */
export async function readPreviousObservation(
  client: SupabaseClient,
  scope: { marketplaceExternalId: string; supplierExternalId: string | null },
): Promise<PreviousObservation | null> {
  const latest = await readLatestAssessment(client, scope);
  if (latest === null) {
    return null;
  }

  const money = await readLinkedEconomics(client, latest.economics_observation_id);
  return {
    assessment: latest.assessment,
    money: money ?? {
      marketplacePriceCents: null,
      supplierCostCents: null,
      supplierShippingCents: null,
      landedCostCents: null,
      estimatedProfitCents: null,
      marginPercent: null,
    },
  };
}
