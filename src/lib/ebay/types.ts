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
  /** Positive-feedback percentage, e.g. 98.7. */
  feedbackPercentage?: number;
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
