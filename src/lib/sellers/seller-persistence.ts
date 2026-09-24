import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createPersistenceClient } from "@/lib/persistence/client";
import { hashMarketplaceSnapshot, hashSellerObservation } from "@/lib/persistence/content-hash";
import { numericToNumber, toCentsOrNull } from "@/lib/persistence/mapping";
import type {
  MarketplaceProductRow,
  MarketplaceSellerObservationRow,
  MarketplaceSellerRow,
  MarketplaceSnapshotRow,
} from "@/lib/persistence/types";

import type { StoredListingRecord } from "./changes";
import type { SellerIdentity, SellerListing } from "./types";

/**
 * Persistence boundary for the Seller Scanner.
 *
 * Reuses the existing append-only marketplace observation layer
 * (`marketplace_products` + `marketplace_product_snapshots`) for everything
 * listing-level, and adds only the seller-side anchor and observation rows the
 * migration introduced (docs/DATABASE.md §6.10). Nothing here invents a figure:
 * a field the scan did not observe is written `null` and read back `null`.
 *
 * Every write path is best-effort by the project's standing rule
 * (docs/ARCHITECTURE.md §13): a persistence failure is *reported*, never thrown,
 * and never turns a successful scan into an error. The scan still returns its
 * listings, categories, pricing and concentration; only the history components
 * degrade.
 */

/** Outcome of a best-effort persistence attempt. */
export type PersistenceOutcome =
  | { status: "ok"; inserted: boolean }
  | { status: "disabled" }
  | { status: "failed"; message: string };

/** What one listing's observation produced, including what it is comparable to. */
export interface ListingObservationResult {
  externalId: string;
  /** Inkora's first-seen time for this listing, preserved across re-scans. */
  firstSeenAt: string | null;
  /** The observation stored just before this one, or null when first seen. */
  previous: StoredListingRecord["latest"] | null;
  /** True when a new snapshot row was appended; false when an identical row was reused. */
  inserted: boolean;
  /** True when a row now represents this observation (appended or reused). */
  appended: boolean;
  /** True when neither could be achieved. */
  failed: boolean;
}

/**
 * Resolves the persistence client, or `null` when persistence is not configured.
 * `null` is a state, not an error: the scanner reports history as unavailable and
 * still returns everything else.
 */
export function resolveSellerPersistence(): SupabaseClient | null {
  try {
    return createPersistenceClient();
  } catch {
    return null;
  }
}

/**
 * Upserts a stable seller identity and appends one seller observation.
 *
 * The observation is deduplicated by content hash against the latest stored row
 * for this seller, so re-scanning an unchanged seller reuses one row while a
 * feedback or count change always appends. The identity is separate from the
 * observation: feedback may move between scans, the seller's history anchor
 * never does.
 */
export async function observeSeller(args: {
  client: SupabaseClient;
  identity: SellerIdentity;
  feedbackPercentage: number | null;
  feedbackScore: number | null;
  observedListingCount: number | null;
  sampledListingCount: number;
  contextQuery: string;
  observedAt: string;
}): Promise<{ sellerId: string } & PersistenceOutcome> {
  const sellerRow = await upsertSellerIdentity(args.client, args.identity, args.observedAt);
  if (sellerRow === null) {
    return {
      sellerId: "",
      status: "failed",
      message: "The seller identity could not be stored, so no seller observation was appended.",
    };
  }

  const contentHash = hashSellerObservation({
    feedbackPercentage: args.feedbackPercentage,
    feedbackScore: args.feedbackScore,
    observedListingCount: args.observedListingCount,
    sampledListingCount: args.sampledListingCount,
    contextQuery: args.contextQuery,
  });

  const existing = await findLatestSellerObservation(args.client, sellerRow.id);
  if (existing !== null && existing.content_hash === contentHash) {
    return { sellerId: sellerRow.id, status: "ok", inserted: false };
  }

  const { error } = await args.client.from("marketplace_seller_observations").insert({
    marketplace_seller_id: sellerRow.id,
    feedback_percentage: args.feedbackPercentage,
    feedback_score: args.feedbackScore,
    observed_listing_count: args.observedListingCount,
    sampled_listing_count: args.sampledListingCount,
    context_query: args.contextQuery,
    provenance_feedback: "OFFICIAL",
    provenance_counts: "OBSERVED",
    content_hash: contentHash,
    observed_at: args.observedAt,
  });

  if (error !== null) {
    return {
      sellerId: sellerRow.id,
      status: "failed",
      message: `The seller observation could not be appended: ${error.message}.`,
    };
  }

  return { sellerId: sellerRow.id, status: "ok", inserted: true };
}

/**
 * Reads and stores the listing observations of one bounded sample.
 *
 * For each listing this:
 *   1. resolves its stable marketplace product identity, **preserving**
 *      `first_seen_at` across re-scans (advancing only `last_seen_at`);
 *   2. reads its most recent stored snapshot — the comparison baseline;
 *   3. appends a new snapshot only when the content hash differs, exactly the
 *      existing deduplication policy.
 *
 * Returns what each listing is comparable to, so change detection is a pure
 * function of the result. Never throws: a failed listing is reported as such and
 * the rest of the sample still lands.
 */
export async function observeSellerListings(args: {
  client: SupabaseClient;
  listings: SellerListing[];
  observedAt: string;
  concurrency: number;
}): Promise<{
  results: ListingObservationResult[];
  stored: number;
  failed: number;
}> {
  const results: ListingObservationResult[] = [];
  let stored = 0;
  let failed = 0;
  const identities = await resolveMarketplaceIdentities({
    client: args.client,
    marketplace: "ebay",
    externalIds: args.listings.map((listing) => listing.externalId),
    observedAt: args.observedAt,
  });

  for (const batch of chunk(args.listings, Math.max(1, args.concurrency))) {
    const settled = await Promise.all(
      batch.map((listing) =>
        observeOneListing({
          client: args.client,
          listing,
          identity: identities.get(listing.externalId) ?? null,
          observedAt: args.observedAt,
        }).then((result) => {
          if (result.inserted) stored += 1;
          if (result.failed) failed += 1;
          return result;
        }),
      ),
    );
    results.push(...settled);
  }

  return { results, stored, failed };
}

/** One listing's read-then-append, resilient to either step failing. */
async function observeOneListing(args: {
  client: SupabaseClient;
  listing: SellerListing;
  identity: MarketplaceProductRow | null;
  observedAt: string;
}): Promise<ListingObservationResult> {
  const identity = args.identity ?? (await insertMarketplaceIdentity(
    args.client,
    { marketplace: args.listing.marketplace, externalId: args.listing.externalId },
    args.observedAt,
  ));
  if (identity === null) {
    return {
      externalId: args.listing.externalId,
      firstSeenAt: null,
      previous: null,
      inserted: false,
      appended: false,
      failed: true,
    };
  }

  const previous = await readLatestSnapshot(args.client, identity.id);
  const columns = listingToSnapshotColumns(args.listing);
  const contentHash = hashMarketplaceSnapshot(columns);

  if (previous !== null && previous.content_hash === contentHash) {
    return {
      externalId: args.listing.externalId,
      firstSeenAt: identity.first_seen_at,
      previous: snapshotRowToObservation(previous),
      inserted: false,
      appended: true,
      failed: false,
    };
  }

  const { error } = await args.client.from("marketplace_product_snapshots").insert({
    marketplace_product_id: identity.id,
    title: columns.title,
    image_url: columns.imageUrl,
    listing_url: columns.listingUrl,
    price_cents: columns.priceCents,
    currency: columns.currency,
    condition: columns.condition,
    seller_identifier: columns.sellerIdentifier,
    seller_feedback_percentage: columns.sellerFeedbackPercentage,
    buyer_shipping_cents: columns.buyerShippingCents,
    shipping_currency: columns.shippingCurrency,
    location: columns.location,
    provenance: columns.provenance,
    content_hash: contentHash,
    observed_at: args.observedAt,
  });

  if (error !== null) {
    // The read baseline is still returned so change detection is not silently
    // skipped; the caller learns the append failed.
    return {
      externalId: args.listing.externalId,
      firstSeenAt: identity.first_seen_at,
      previous: snapshotRowToObservation(previous),
      inserted: false,
      appended: false,
      failed: true,
    };
  }

  return {
    externalId: args.listing.externalId,
    firstSeenAt: identity.first_seen_at,
    previous: snapshotRowToObservation(previous),
    inserted: true,
    appended: true,
    failed: false,
  };
}

/**
 * The external ids previously observed for a seller — the set the current
 * bounded sample is compared against to report absences.
 *
 * Served index-only by `idx_marketplace_snapshots_seller_product`. Absence from
 * this set is evidence of nothing more than absence from this scan's window
 * (docs/ARCHITECTURE.md §17 listing-changes): it is never a delisting verdict.
 */
export async function readPreviouslySeenListingExternalIds(
  client: SupabaseClient,
  sellerHandle: string,
): Promise<string[]> {
  const { data, error } = await client
    .from("marketplace_product_snapshots")
    .select("marketplace_product_id, marketplace_products!inner(external_id)")
    .eq("seller_identifier", sellerHandle);

  if (error !== null || data === null || !Array.isArray(data)) {
    return [];
  }

  const ids = new Set<string>();
  for (const row of data as Array<{
    marketplace_products:
      | { external_id: string | null }
      | { external_id: string | null }[]
      | null;
  }>) {
    const joined = row.marketplace_products;
    const externalId = Array.isArray(joined) ? joined[0]?.external_id : joined?.external_id;
    if (typeof externalId === "string") ids.add(externalId);
  }
  return [...ids].sort();
}

/**
 * Reads the seller's stored observations, newest first, bounded. Used to surface
 * seller-level history (feedback movement) without exposing raw rows upward.
 */
export async function readSellerHistory(
  client: SupabaseClient,
  sellerId: string,
  limit: number,
): Promise<MarketplaceSellerObservationRow[]> {
  const { data, error } = await client
    .from("marketplace_seller_observations")
    .select("*")
    .eq("marketplace_seller_id", sellerId)
    .order("observed_at", { ascending: false })
    .limit(limit);

  if (error !== null || data === null) return [];
  return data as MarketplaceSellerObservationRow[];
}

// --- internals ----------------------------------------------------------------

/**
 * Resolves stable marketplace product identities for a sample, **preserving**
 * `first_seen_at` on re-scan. The shared upsert cannot be used here: it rewrites
 * `first_seen_at` on every conflict, which would erase the very first-seen
 * record the seller scanner reports. Existing rows are read, missing ones
 * inserted, and only `last_seen_at` advanced.
 */
async function resolveMarketplaceIdentities(args: {
  client: SupabaseClient;
  marketplace: string;
  externalIds: string[];
  observedAt: string;
}): Promise<Map<string, MarketplaceProductRow>> {
  if (args.externalIds.length === 0) return new Map();

  const { data, error } = await args.client
    .from("marketplace_products")
    .select("id, marketplace, external_id, first_seen_at, last_seen_at")
    .eq("marketplace", args.marketplace)
    .in("external_id", args.externalIds);

  const byExternalId = new Map<string, MarketplaceProductRow>();
  if (error === null && Array.isArray(data)) {
    for (const row of data as MarketplaceProductRow[]) {
      byExternalId.set(row.external_id, row);
    }
  }

  const missing = args.externalIds.filter(
    (externalId) => !byExternalId.has(externalId),
  );
  for (const externalId of missing) {
    const inserted = await insertMarketplaceIdentity(
      args.client,
      { marketplace: args.marketplace, externalId },
      args.observedAt,
    );
    if (inserted !== null) byExternalId.set(externalId, inserted);
  }

  const existingIds = [...byExternalId.values()]
    .filter((row) => !missing.includes(row.external_id))
    .map((row) => row.id);
  if (existingIds.length > 0) {
    await args.client
      .from("marketplace_products")
      .update({ last_seen_at: args.observedAt, updated_at: new Date().toISOString() })
      .in("id", existingIds);
  }

  return byExternalId;
}

/** Inserts one marketplace product identity, returning the row or null. */
async function insertMarketplaceIdentity(
  client: SupabaseClient,
  scope: { marketplace: string; externalId: string },
  observedAt: string,
): Promise<MarketplaceProductRow | null> {
  const { data, error } = await client
    .from("marketplace_products")
    .insert({
      marketplace: scope.marketplace,
      external_id: scope.externalId,
      first_seen_at: observedAt,
      last_seen_at: observedAt,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error !== null || data === null) return null;
  return data as MarketplaceProductRow;
}

/** The most recent stored snapshot for one product, or null when none exists. */
async function readLatestSnapshot(
  client: SupabaseClient,
  productId: string,
): Promise<MarketplaceSnapshotRow | null> {
  const { data, error } = await client
    .from("marketplace_product_snapshots")
    .select("*")
    .eq("marketplace_product_id", productId)
    .order("observed_at", { ascending: false })
    .limit(1);

  if (error !== null || data === null || data.length === 0) return null;
  return data[0] as MarketplaceSnapshotRow;
}

/** The most recent seller observation, or null when none exists. */
async function findLatestSellerObservation(
  client: SupabaseClient,
  sellerId: string,
): Promise<MarketplaceSellerObservationRow | null> {
  const { data, error } = await client
    .from("marketplace_seller_observations")
    .select("*")
    .eq("marketplace_seller_id", sellerId)
    .order("observed_at", { ascending: false })
    .limit(1);

  if (error !== null || data === null || data.length === 0) return null;
  return data[0] as MarketplaceSellerObservationRow;
}

/** Upserts the stable seller identity, preserving `first_seen_at`. */
async function upsertSellerIdentity(
  client: SupabaseClient,
  identity: SellerIdentity,
  observedAt: string,
): Promise<MarketplaceSellerRow | null> {
  const { data: existing, error: readError } = await client
    .from("marketplace_sellers")
    .select("id, marketplace, external_seller_id, username, first_seen_at, last_seen_at")
    .eq("marketplace", identity.marketplace)
    .eq("external_seller_id", identity.externalSellerId)
    .limit(1);

  if (readError === null && Array.isArray(existing) && existing.length > 0) {
    const row = existing[0] as MarketplaceSellerRow;
    const { error: updateError } = await client
      .from("marketplace_sellers")
      .update({
        username: identity.username,
        last_seen_at: observedAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (updateError !== null) return null;
    return { ...row, username: identity.username, last_seen_at: observedAt };
  }

  const { data, error } = await client
    .from("marketplace_sellers")
    .insert({
      marketplace: identity.marketplace,
      external_seller_id: identity.externalSellerId,
      username: identity.username,
      first_seen_at: observedAt,
      last_seen_at: observedAt,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error !== null || data === null) return null;
  return data as MarketplaceSellerRow;
}

/** Maps a normalized seller listing to the stored snapshot's column shape. */
function listingToSnapshotColumns(listing: SellerListing) {
  return {
    title: listing.title,
    imageUrl: listing.imageUrl,
    listingUrl: listing.listingUrl,
    priceCents: toCentsOrNull(listing.price),
    currency: listing.currency,
    condition: listing.condition,
    sellerIdentifier: listing.sellerName,
    sellerFeedbackPercentage: listing.sellerFeedbackPercentage,
    buyerShippingCents: toCentsOrNull(listing.shippingCost),
    shippingCurrency: listing.shippingCurrency,
    location: listing.location,
    provenance: listing.provenance,
  };
}

/** A stored snapshot row as the change-detection comparison baseline. */
function snapshotRowToObservation(
  row: MarketplaceSnapshotRow | null,
): StoredListingRecord["latest"] | null {
  if (row === null) return null;
  return {
    externalId: row.marketplace_product_id,
    title: row.title,
    price: centsToDecimalOrNull(row.price_cents),
    currency: row.currency,
    condition: row.condition,
    shippingCost: centsToDecimalOrNull(row.buyer_shipping_cents),
    shippingCurrency: row.shipping_currency,
    primaryCategoryId: null,
    sellerIdentifier: row.seller_identifier,
    observedAt: row.observed_at,
  };
}

/** Formats stored minor units back to the decimal-string comparison contract. */
function centsToDecimalOrNull(cents: number | string | null): string | null {
  const value = numericToNumber(cents);
  if (value === null) return null;
  return (value / 100).toFixed(2);
}

/** Splits an array into bounded chunks for deterministic concurrency. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
