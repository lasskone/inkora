/**
 * Minimal typing of the eBay API responses this implementation actually needs.
 *
 * Deliberately incomplete: only the subset of the Browse API
 * `item_summary/search` collection and the OAuth token envelope that Inkora
 * consumes is modeled. Fields the adapter ignores are left untyped rather than
 * guessed, and every field eBay marks "Occurrence: Conditional" is optional.
 */

/** Monetary amount as returned by eBay (`value` is a decimal string). */
export interface EbayConvertedAmount {
  value: string;
  currency: string;
  convertedFromValue?: string;
  convertedFromCurrency?: string;
}

export interface EbayImage {
  imageUrl: string;
  width?: number;
  height?: number;
}

export interface EbaySeller {
  /** Display name, or for US listings an immutable user id (eBay data-handling change). */
  username?: string;
  /**
   * Positive-feedback percentage, e.g. 98.7. eBay serializes this as a numeric
   * *string* in `item_summary/search` payloads, so both forms are accepted.
   */
  feedbackPercentage?: number | string;
  feedbackScore?: number;
  sellerAccountType?: string;
}

export interface EbayItemLocation {
  country?: string;
  city?: string;
  stateOrProvince?: string;
  postalCode?: string;
}

export interface EbayShippingOptionSummary {
  type?: string;
  shippingCost?: EbayConvertedAmount;
  shippingCostType?: string;
  minEstimatedDeliveryDate?: string;
  maxEstimatedDeliveryDate?: string;
}

export interface EbayItemSummary {
  itemId?: string;
  title?: string;
  price?: EbayConvertedAmount;
  /** Primary image on an item summary. */
  image?: EbayImage;
  itemWebUrl?: string;
  seller?: EbaySeller;
  itemLocation?: EbayItemLocation;
  /** eBay condition vocabulary: NEW, USED, REFURBISHED, UNSPECIFIED, ... */
  condition?: string;
  shippingOptions?: EbayShippingOptionSummary[];
  buyingOptions?: string[];
  topRatedBuyingExperience?: boolean;
  categories?: { categoryId?: string; categoryName?: string }[];
  /** The marketplace's own listing creation timestamp (publication date). */
  itemCreationDate?: string;
  /** Listing end timestamp; present for time-limited formats such as auctions. */
  itemEndDate?: string;
  /** eBay's product identifier for the item, when one is assigned. */
  epid?: string;
  /** Numeric condition vocabulary (e.g. `1000` for NEW). */
  conditionId?: string;
}

/**
 * eBay `SearchPagedCollection` — the envelope of `GET item_summary/search`.
 */
export interface EbaySearchPagedCollection {
  href?: string;
  limit?: number;
  offset?: number;
  total?: number;
  itemSummaries?: EbayItemSummary[];
}

/**
 * A seller-scoped `item_summary/search` envelope.
 *
 * Structurally identical to a plain search, but the response's `warnings` matter
 * here in a way they do not for a keyword search: when eBay dislikes the seller
 * filter it returns HTTP 200 with the *unfiltered* result set and a warning
 * (verified against the live API). A caller that ignores `warnings` would hand
 * the user some other seller's inventory, so the field is modeled explicitly.
 */
export interface EbaySellerSearchPagedCollection extends EbaySearchPagedCollection {
  warnings?: EbayApiWarning[];
}

/** One non-fatal objection eBay records against a request. */
export interface EbayApiWarning {
  errorId?: number;
  domain?: string;
  category?: string;
  message?: string;
  parameters?: { name?: string; value?: string }[];
}

/**
 * The sort orders the seller-scoped search uses. `newlyListed` is the
 * marketplace's own publication-order sort (by `itemCreationDate`), so the
 * "recently added" view is the provider's ordering, never Inkora's inference.
 */
export type EbaySellerSort = "newlyListed";

/** OAuth2 client-credentials token response. */
export interface EbayApplicationAccessToken {
  access_token: string;
  /** Lifetime in seconds (eBay typically returns 7200). */
  expires_in: number;
  token_type: string;
}

/** OAuth2 token-request error envelope. */
export interface EbayOAuthError {
  error?: string;
  error_description?: string;
}
