/**
 * Deterministic content hashing for the deduplication policy.
 *
 * The persistence layer is append-oriented, but repeatedly receiving *exactly
 * the same observation should not create unbounded database growth
 * (docs/DATABASE.md §7). The V1 policy is:
 *
 *   append a new observation row only when a MEANINGFUL field changed
 *   relative to the most recent observation for the same identity.
 *
 * "Meaningful" is defined per table by the field list hashed here. The digest
 * is a stable `sha256` over a canonical JSON encoding, so the decision is
 * deterministic: the same inputs always produce the same hash, and therefore
 * the same append-or-skip verdict on every run.
 *
 * What is deliberately NOT part of the hash:
 *   - `observed_at` / `calculated_at` — two observations a second apart with
 *     identical content are the *same* observation; hashing the time would
 *     defeat deduplication entirely.
 *   - `ingested_at` — database insertion time is not upstream truth.
 *   - database-generated ids and foreign keys — they are not observed data.
 *
 * This module is pure (no `server-only`, no I/O) so the dedup policy is
 * unit-testable without any network or credentials.
 */

import { createHash } from "node:crypto";

/**
 * Canonicalizes a value into a byte-encoding-independent JSON string so the
 * hash never depends on object key insertion order or on locale.
 *
 * Object keys are sorted recursively; arrays keep their order (order *is*
 * significant for signals and quotes). `null` and `undefined` are both encoded
 * as `null`, because a field the provider omitted and a field it returned
 * empty are the same observation.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object") {
    const sortedEntries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]);
    return Object.fromEntries(sortedEntries);
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return value;
}

/**
 * Hashes a canonical JSON payload with sha256 and returns a hex digest.
 *
 * sha256 is used purely as a fixed-length comparison key: it is not a security
 * boundary, and the full observation is still stored alongside it.
 */
export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * Hashes the time-varying, observed fields of a marketplace listing.
 *
 * The hashed object is deliberately a plain, nested structure of the fields
 * that constitute "this observation" — identity fields (`external_id`) are
 * excluded because they are already fixed by the row's foreign key.
 */
export function hashMarketplaceSnapshot(input: {
  title: string;
  imageUrl: string | null;
  listingUrl: string | null;
  priceCents: number | null;
  currency: string | null;
  condition: string | null;
  sellerIdentifier: string | null;
  sellerFeedbackPercentage: number | null;
  buyerShippingCents: number | null;
  shippingCurrency: string | null;
  location: string | null;
  provenance: string;
}): string {
  return digestJson({
    title: input.title,
    imageUrl: input.imageUrl,
    listingUrl: input.listingUrl,
    priceCents: input.priceCents,
    currency: input.currency,
    condition: input.condition,
    sellerIdentifier: input.sellerIdentifier,
    sellerFeedbackPercentage: input.sellerFeedbackPercentage,
    buyerShippingCents: input.buyerShippingCents,
    shippingCurrency: input.shippingCurrency,
    location: input.location,
    provenance: input.provenance,
  });
}

/** Hashes the time-varying, observed fields of a supplier product. */
export function hashSupplierSnapshot(input: {
  title: string;
  imageUrl: string | null;
  productUrl: string | null;
  category: string | null;
  catalogReferencePriceCents: number | null;
  currency: string | null;
  availableInventory: number | null;
  warehouseCountry: string | null;
  shippingOrigin: string | null;
  provenance: string;
}): string {
  return digestJson({
    title: input.title,
    imageUrl: input.imageUrl,
    productUrl: input.productUrl,
    category: input.category,
    catalogReferencePriceCents: input.catalogReferencePriceCents,
    currency: input.currency,
    availableInventory: input.availableInventory,
    warehouseCountry: input.warehouseCountry,
    shippingOrigin: input.shippingOrigin,
    provenance: input.provenance,
  });
}

/** Hashes the time-varying, observed fields of one supplier variant. */
export function hashSupplierVariantSnapshot(input: {
  title: string | null;
  priceCents: number | null;
  currency: string | null;
  availableInventory: number | null;
  warehouseCountries: string[] | null;
  provenance: string;
}): string {
  return digestJson({
    title: input.title,
    priceCents: input.priceCents,
    currency: input.currency,
    availableInventory: input.availableInventory,
    warehouseCountries: input.warehouseCountries,
    provenance: input.provenance,
  });
}

/**
 * Hashes a match observation: the matcher version, the confidence it produced,
 * and the full reasoning (signals and contradictions). The explanation string
 * is excluded because it is a deterministic function of the other fields, so
 * including it would add no deduplication signal.
 */
export function hashMatchObservation(input: {
  matcherVersion: string;
  confidence: number;
  confidenceBand: string;
  signals: unknown;
  contradictions: unknown;
}): string {
  return digestJson({
    matcherVersion: input.matcherVersion,
    confidence: input.confidence,
    confidenceBand: input.confidenceBand,
    signals: input.signals,
    contradictions: input.contradictions,
  });
}

/**
 * Hashes an economics observation: every monetary component, the cost basis,
 * the fee-engine version, and the completeness verdict.
 *
 * The fee *engine version* is included on purpose (docs/DATABASE.md §15): the
 * same inputs under a new fee-rule version are a *different* calculation and
 * must be recorded as a new historical observation.
 */
export function hashEconomicsObservation(input: {
  feeEngineVersion: string;
  economicsEngineVersion: string;
  completeness: string;
  itemPriceCents: number | null;
  buyerShippingCents: number | null;
  grossMarketplaceRevenueCents: number | null;
  currency: string | null;
  supplierProductCostCents: number | null;
  supplierCostBasis: string | null;
  supplierShippingCents: number | null;
  supplierShippingMethod: string | null;
  landedCostCents: number | null;
  marketplaceFeeCents: number | null;
  estimatedProfitCents: number | null;
  marginPercentCents: number | null;
  shippingDestination: unknown;
}): string {
  return digestJson({
    feeEngineVersion: input.feeEngineVersion,
    economicsEngineVersion: input.economicsEngineVersion,
    completeness: input.completeness,
    itemPriceCents: input.itemPriceCents,
    buyerShippingCents: input.buyerShippingCents,
    grossMarketplaceRevenueCents: input.grossMarketplaceRevenueCents,
    currency: input.currency,
    supplierProductCostCents: input.supplierProductCostCents,
    supplierCostBasis: input.supplierCostBasis,
    supplierShippingCents: input.supplierShippingCents,
    supplierShippingMethod: input.supplierShippingMethod,
    landedCostCents: input.landedCostCents,
    marketplaceFeeCents: input.marketplaceFeeCents,
    estimatedProfitCents: input.estimatedProfitCents,
    marginPercentCents: input.marginPercentCents,
    shippingDestination: input.shippingDestination,
  });
}
