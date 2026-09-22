/**
 * Pure mapping helpers between the provider-independent normalized models and
 * the persistence row shapes.
 *
 * The single rule that governs every line here (docs/DATABASE.md §8): money is
 * converted from the normalized models' decimal-string contract into integer
 * minor units using the project's existing money primitives, and converted
 * back with their inverse. No binary floating point is ever introduced, and a
 * field the provider did not return stays `null` instead of becoming a
 * fabricated zero.
 *
 * This module is pure (no `server-only`, no I/O) so the money and nullability
 * contract is unit-testable without any network or credentials.
 */

import { formatCents, parseDecimalToCents } from "@/lib/economics/money";
import type { MarketplaceProduct } from "@/lib/marketplace/types";
import type { Provenance } from "@/lib/marketplace/types";
import type { SupplierProduct, SupplierVariant } from "@/lib/supplier/types";

/**
 * Converts a decimal string from a normalized model into database minor units,
 * or `null` when the value is absent or uninterpretable.
 *
 * `parseDecimalToCents` already implements the documented policy (half-up
 * rounding on the third digit, CJ price ranges resolve to their low end). It is
 * reused verbatim so persistence and economics can never disagree about what a
 * price means.
 */
export function toCentsOrNull(value: string | number | null | undefined): number | null {
  return parseDecimalToCents(value ?? null);
}

/**
 * Reads a nullable numeric column back as a plain number.
 *
 * Supabase returns `numeric` columns as strings by default; this accepts both
 * shapes and yields `null` for absent values.
 */
export function numericToNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Formats stored minor units back into the decimal-string contract the
 * normalized models and the UI use, or `null` when the value is absent.
 */
export function centsToDecimalOrNull(cents: number | null): string | null {
  if (cents === null) {
    return null;
  }
  return formatCents(cents);
}

/**
 * Hard ceiling on how many observations one historical read may return. The
 * scanner never needs an unbounded history, and the API never hands out an
 * unbounded cursor (docs/DATABASE.md §8, docs/ARCHITECTURE.md §14).
 */
export const MAX_HISTORY_LIMIT = 50;

/** Page size used when the caller does not name one. */
export const DEFAULT_HISTORY_LIMIT = 20;

/**
 * Bounds a requested page size to the documented ceiling and a sane floor, and
 * falls back to the default for anything unusable.
 *
 * Pure on purpose: the bound is a contract worth unit-testing without any
 * database or credentials.
 */
export function clampLimit(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return DEFAULT_HISTORY_LIMIT;
  }
  const bounded = Math.trunc(requested);
  return Math.min(Math.max(bounded, 1), MAX_HISTORY_LIMIT);
}

/**
 * Maps a normalized `MarketplaceProduct` to the column values of a
 * `marketplace_product_snapshots` insert.
 *
 * Every absent field stays `null`; nothing is defaulted, coerced, or invented.
 */
export function marketplaceProductToSnapshotColumns(product: MarketplaceProduct): {
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
} {
  return {
    title: product.title,
    imageUrl: product.imageUrl,
    listingUrl: product.listingUrl,
    priceCents: toCentsOrNull(product.price),
    currency: product.currency,
    condition: product.condition,
    sellerIdentifier: product.sellerName,
    sellerFeedbackPercentage: product.sellerFeedbackPercentage,
    buyerShippingCents: toCentsOrNull(product.shippingCost),
    shippingCurrency: product.shippingCurrency,
    location: product.location,
    provenance: product.provenance,
  };
}

/**
 * Maps a normalized `SupplierProduct` to `supplier_product_snapshots` columns.
 *
 * `supplierPrice` is stored as the *catalogue reference price* — CJ documents
 * it as a catalogue-level minimum, and for multi-variant products it is a range
 * whose low end is a lower bound, never the definitive variant cost. The
 * distinction is preserved by the column name downstream
 * (docs/DATABASE.md §6.4).
 */
export function supplierProductToSnapshotColumns(product: SupplierProduct): {
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
} {
  return {
    title: product.title,
    imageUrl: product.imageUrl,
    productUrl: product.productUrl,
    category: product.category,
    catalogReferencePriceCents: toCentsOrNull(product.supplierPrice),
    currency: product.currency,
    availableInventory: product.availableInventory,
    warehouseCountry: product.warehouseCountry,
    shippingOrigin: product.shippingOrigin,
    provenance: product.provenance,
  };
}

/**
 * Maps a normalized `SupplierVariant` to `supplier_variant_snapshots` columns.
 *
 * The variant price is the cost economics actually uses, and is therefore kept
 * strictly separate from the parent product's catalogue reference price.
 */
export function supplierVariantToSnapshotColumns(variant: SupplierVariant): {
  title: string | null;
  priceCents: number | null;
  currency: string | null;
  availableInventory: number | null;
  warehouseCountries: string[] | null;
  provenance: string;
} {
  return {
    title: variant.title,
    priceCents: toCentsOrNull(variant.price),
    // The normalized variant model carries no currency: CJ does not state one
    // per variant, so nothing is invented here (docs/DATABASE.md §6.5).
    currency: null,
    availableInventory: variant.availableInventory,
    warehouseCountries: variant.warehouseCountries ?? null,
    provenance: "OFFICIAL",
  };
}

/**
 * Converts a stored `marketplace_product_snapshots` row back into the
 * decimal-string money representation used by the API and UI. Accepts the loose
 * row shape a Supabase select returns (numeric columns arrive as strings).
 */
export function marketplaceSnapshotRowToReadModel(row: {
  title: string;
  image_url: string | null;
  listing_url: string | null;
  price_cents: number | string | null;
  currency: string | null;
  condition: string | null;
  seller_identifier: string | null;
  seller_feedback_percentage: number | string | null;
  buyer_shipping_cents: number | string | null;
  shipping_currency: string | null;
  location: string | null;
  provenance: string;
  observed_at: string;
}): {
  title: string;
  imageUrl: string | null;
  listingUrl: string | null;
  price: string | null;
  currency: string | null;
  condition: string | null;
  sellerName: string | null;
  sellerFeedbackPercentage: number | null;
  shippingCost: string | null;
  shippingCurrency: string | null;
  location: string | null;
  provenance: Provenance;
  observedAt: string;
} {
  return {
    title: row.title,
    imageUrl: row.image_url,
    listingUrl: row.listing_url,
    price: centsToDecimalOrNull(numericToNumber(row.price_cents)),
    currency: row.currency,
    condition: row.condition,
    sellerName: row.seller_identifier,
    sellerFeedbackPercentage: numericToNumber(row.seller_feedback_percentage),
    shippingCost: centsToDecimalOrNull(numericToNumber(row.buyer_shipping_cents)),
    shippingCurrency: row.shipping_currency,
    location: row.location,
    // The column is `public.provenance NOT NULL`, so the value is always one of
    // the three enum members.
    provenance: row.provenance as Provenance,
    observedAt: row.observed_at,
  };
}

/**
 * Converts the economics layer's margin percentage string (e.g. `"36.99"`) into
 * the database's percent-cents encoding (`3699`), or `null` when absent.
 *
 * The column stores 1/100 of a percent, so a percentage number is multiplied by
 * 100 — this is NOT a money conversion, and it is deliberately a separate helper
 * from `toCentsOrNull` so the two encodings can never be confused
 * (docs/DATABASE.md §8).
 */
export function marginPercentToPercentCents(
  value: string | null | undefined,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const percent = Number(value.trim());
  if (!Number.isFinite(percent)) {
    return null;
  }
  return Math.round(percent * 100);
}

/**
 * Inverse of `marginPercentToPercentCents`, for the historical read path: stored
 * percent-cents become a percentage string again (e.g. `3699` → `"36.99"`).
 */
export function percentCentsToMarginPercent(
  percentCents: number | null,
): string | null {
  if (percentCents === null) {
    return null;
  }
  return (percentCents / 100).toString();
}

