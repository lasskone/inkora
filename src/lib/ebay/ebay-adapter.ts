import "server-only";

import { requireEbayConfig } from "./config";
import { searchEbayItemSummaries } from "./browse-api";
import type {
  MarketplaceAdapter,
  MarketplaceProduct,
  MarketplaceSearchRequest,
  MarketplaceSearchResult,
} from "@/lib/marketplace/types";
import type {
  EbayConvertedAmount,
  EbayItemLocation,
  EbayItemSummary,
  EbayShippingOptionSummary,
} from "./types";

/**
 * `MarketplaceAdapter` implementation for eBay.
 *
 * This is the only place in Inkora that knows about eBay: it owns the OAuth2
 * client-credentials handshake, the Browse API request shape, and the mapping
 * from eBay's response into Inkora's provider-independent marketplace model.
 * Core domain logic never imports from this module.
 *
 * Everything emitted here is sourced directly from the official, authenticated
 * eBay API, so every value carries provenance `OFFICIAL`. Fields eBay does not
 * return are `null` — never guessed and never converted into fake estimates.
 */
export class EbayAdapter implements MarketplaceAdapter {
  readonly marketplace = "ebay" as const;

  async search(
    request: MarketplaceSearchRequest,
  ): Promise<MarketplaceSearchResult> {
    const config = requireEbayConfig();
    const offset = clampOffset(request.offset ?? 0);

    const collection = await searchEbayItemSummaries(config, {
      query: request.query,
      limit: request.limit,
      offset,
    });

    const summaries = Array.isArray(collection.itemSummaries)
      ? collection.itemSummaries
      : [];

    const products = summaries
      .map((summary) => normalizeItemSummary(summary))
      .filter((product): product is MarketplaceProduct => product !== null);

    return {
      query: request.query,
      limit: request.limit,
      offset,
      total: typeof collection.total === "number" ? collection.total : null,
      count: products.length,
      products,
    };
  }
}

/** eBay caps a search result set at 10,000 items; bound the offset accordingly. */
const MAX_OFFSET = 9_999;

function clampOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(Math.trunc(offset), 0), MAX_OFFSET);
}

/**
 * Maps one eBay item summary to the normalized model.
 *
 * Defensive by design: a summary missing a field degrades to `null` for that
 * field, and a summary missing its id or title is dropped entirely rather than
 * emitting a half-empty record downstream.
 */
function normalizeItemSummary(
  summary: EbayItemSummary,
): MarketplaceProduct | null {
  const externalId = summary.itemId;
  const title = summary.title;

  if (!externalId || !title) {
    return null;
  }

  const shipping = pickCheapestShipping(summary.shippingOptions);

  return {
    marketplace: "ebay",
    externalId,
    title,
    imageUrl: pickImageUrl(summary),
    listingUrl: summary.itemWebUrl ?? null,
    price: summary.price?.value ?? null,
    currency: summary.price?.currency ?? null,
    condition: summary.condition ?? null,
    sellerName: summary.seller?.username ?? null,
    sellerFeedbackPercentage: normalizeFeedbackPercentage(
      summary.seller?.feedbackPercentage,
    ),
    shippingCost: shipping?.value ?? null,
    shippingCurrency: shipping?.currency ?? null,
    location: formatLocation(summary.itemLocation),
    provenance: "OFFICIAL",
    fetchedAt: new Date().toISOString(),
  };
}

function pickImageUrl(summary: EbayItemSummary): string | null {
  const candidate = summary.image?.imageUrl;
  if (typeof candidate !== "string" || !/^https?:\/\//i.test(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Chooses the cheapest shipping option eBay actually priced.
 *
 * If eBay prices no option, shipping stays honestly `null` — Inkora does not
 * infer "free" from absence.
 */
function pickCheapestShipping(
  options: EbayShippingOptionSummary[] | undefined,
): EbayConvertedAmount | null {
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }

  let cheapest: EbayConvertedAmount | null = null;
  let cheapestAmount = Number.POSITIVE_INFINITY;

  for (const option of options) {
    const cost = option.shippingCost;
    if (!cost || typeof cost.value !== "string") continue;
    const amount = Number(cost.value);
    if (!Number.isFinite(amount)) continue;
    if (amount < cheapestAmount) {
      cheapestAmount = amount;
      cheapest = cost;
    }
  }

  return cheapest;
}

function normalizeFeedbackPercentage(
  value: number | undefined,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function formatLocation(location: EbayItemLocation | undefined): string | null {
  if (!location) return null;
  const parts = [location.city, location.country]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}
