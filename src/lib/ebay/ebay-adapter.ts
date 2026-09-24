import "server-only";

import { requireEbayConfig } from "./config";
import { searchEbayItemSummaries } from "./browse-api";
import { searchEbaySellerListings, sellerFilterRejected } from "./seller-search";
import type {
  MarketplaceAdapter,
  MarketplaceProduct,
  MarketplaceSearchRequest,
  MarketplaceSearchResult,
} from "@/lib/marketplace/types";
import type {
  SellerListingsRequest,
  SellerListingsResult,
} from "@/lib/sellers/seller-ports";
import type { SellerListing } from "@/lib/sellers/types";
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

  /**
   * Seller-scoped search.
   *
   * Same endpoint and normalization as `search`, scoped by the `sellers` filter
   * to one seller's listings *within a search context* — the marketplace cannot
   * enumerate a seller's whole inventory, and this contract says so rather than
   * pretending to.
   *
   * Reports `sellerFilterRejected` when eBay's warnings object to the scoping,
   * because the response in that case is the *unfiltered* result set and must
   * never be presented as the requested seller's listings.
   */
  async searchSellerListings(
    request: SellerListingsRequest,
  ): Promise<SellerListingsResult> {
    const config = requireEbayConfig();
    const offset = snapOffsetToGrid(request.offset, request.limit);

    const collection = await searchEbaySellerListings(config, {
      query: request.query,
      sellerHandle: request.sellerHandle,
      limit: request.limit,
      offset,
      sort: request.sort,
    });

    const summaries = Array.isArray(collection.itemSummaries)
      ? collection.itemSummaries
      : [];

    const listings = summaries
      .map((summary) => normalizeItemSummaryToSellerListing(summary))
      .filter((listing): listing is SellerListing => listing !== null);

    return {
      query: request.query,
      limit: request.limit,
      offset,
      total: typeof collection.total === "number" ? collection.total : null,
      count: listings.length,
      listings,
      sellerFilterRejected: sellerFilterRejected(collection),
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

/**
 * eBay serializes `feedbackPercentage` as a numeric string (e.g. `"98.7"`) in
 * item summaries, though it is always a percentage. Parse it into a number so
 * the normalized model carries a real value; anything absent or non-numeric
 * stays honestly `null` rather than being coerced to a fake 0.
 */
function normalizeFeedbackPercentage(
  value: number | string | undefined,
): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function formatLocation(location: EbayItemLocation | undefined): string | null {
  if (!location) return null;
  const parts = [location.city, location.country]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Maps one eBay item summary into the seller-scoped listing model.
 *
 * Carries every field `normalizeItemSummary` produces plus the seller-relevant
 * fields the Browse API exposes on a summary: the category path (leaf first),
 * buying options, the listing creation timestamp and the auction end date.
 *
 * Defensive exactly like its sibling: a missing field degrades to `null`, and a
 * summary missing its id or title is dropped rather than emitted half-empty.
 */
function normalizeItemSummaryToSellerListing(
  summary: EbayItemSummary,
): SellerListing | null {
  const externalId = summary.itemId;
  const title = summary.title;

  if (!externalId || !title) {
    return null;
  }

  const shipping = pickCheapestShipping(summary.shippingOptions);
  const categories = pickCategories(summary.categories);
  const primary = categories.length > 0 ? categories[0] : null;

  return {
    marketplace: "ebay",
    externalId,
    title,
    imageUrl: pickImageUrl(summary),
    listingUrl: summary.itemWebUrl ?? null,
    price: summary.price?.value ?? null,
    currency: summary.price?.currency ?? null,
    condition: summary.condition ?? null,
    conditionId: summary.conditionId ?? null,
    sellerName: summary.seller?.username ?? null,
    sellerFeedbackPercentage: normalizeFeedbackPercentage(
      summary.seller?.feedbackPercentage,
    ),
    sellerFeedbackScore: normalizeFeedbackScore(summary.seller?.feedbackScore),
    shippingCost: shipping?.value ?? null,
    shippingCurrency: shipping?.currency ?? null,
    location: formatLocation(summary.itemLocation),
    primaryCategoryId: primary?.categoryId ?? null,
    primaryCategoryName: primary?.categoryName ?? null,
    categories,
    buyingOptions: Array.isArray(summary.buyingOptions)
      ? [...summary.buyingOptions]
      : [],
    itemCreationDate: summary.itemCreationDate ?? null,
    itemEndDate: summary.itemEndDate ?? null,
    epid: summary.epid ?? null,
    provenance: "OFFICIAL",
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * The category path, leaf-first as eBay returns it, with empty entries dropped.
 * The primary category is the leaf — the most specific classification the
 * marketplace gives the listing.
 */
function pickCategories(
  categories: EbayItemSummary["categories"],
): SellerListing["categories"] {
  if (!Array.isArray(categories)) return [];
  return categories
    .map((category) => ({
      categoryId: category.categoryId ?? "",
      categoryName: category.categoryName ?? "",
    }))
    .filter((category) => category.categoryId.length > 0);
}

/**
 * eBay requires `offset` to be a multiple of `limit` and caps a result set at
 * 10,000 items; any other offset is an error upstream. Snap the caller's value
 * onto that grid rather than letting a legitimate request fail.
 */
function snapOffsetToGrid(offset: number, limit: number): number {
  if (!Number.isFinite(offset)) return 0;
  const truncated = Math.trunc(offset);
  if (truncated <= 0) return 0;
  const safeLimit = limit > 0 ? limit : 1;
  const snapped = Math.floor(truncated / safeLimit) * safeLimit;
  return Math.min(snapped, MAX_OFFSET);
}

/**
 * eBay serializes `feedbackScore` as a number on item summaries. Absent or
 * non-finite values stay honestly `null` rather than becoming a fake zero.
 */
function normalizeFeedbackScore(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}
