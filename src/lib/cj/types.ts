/**
 * Minimal typing of the CJdropshipping API responses this implementation
 * actually needs.
 *
 * API version assumption: the **official CJ API 2.0** gateway, base
 * `https://developers.cjdropshipping.com/api2.0/v1/` (verified against the
 * official documentation at developers.cjdropshipping.com, and verified live —
 * registered paths answer HTTP 401 without a token, unknown paths answer the
 * standard `1600101 "Interface not found"` envelope).
 *
 * Deliberately incomplete: only the subset of the product search, inventory and
 * authentication envelopes that Inkora consumes is modeled. Fields the adapter
 * ignores are left untyped rather than guessed, and every field CJ marks
 * optional is optional here. Field names preserve CJ's own casing: the current
 * `listV2` search documents camelCase (`nameEn`, `sellPrice`, `bigImage`), while
 * older endpoints used snake_case (`nameen`, `sellprice`, `newImgList`) — both
 * spellings are tolerated so a CJ version bump cannot silently break mapping.
 */

/**
 * The uniform CJ API 2.0 envelope. Every endpoint — including failures —
 * answers with this shape. CJ signals logical failure with HTTP 200 plus
 * `result: false`, so `result`/`code` must be checked even on a 2xx response.
 * `pointsInfo` carries the call-quota counters CJ publishes per request.
 */
export interface CjEnvelope<T> {
  code?: number;
  result?: boolean;
  message?: string;
  data?: T | null;
  requestId?: string;
  pointsInfo?: {
    total?: number;
    usedToday?: number;
    remaining?: number;
  };
  success?: boolean;
}

/**
 * One product row from `GET /v1/product/listV2`.
 *
 * CJ returns an extremely large document for each product; only the fields the
 * normalizer reads are declared. Prices arrive as decimal strings.
 */
export interface CjProduct {
  /** Product id; `id` on the listV2 response, `pid` on legacy endpoints. */
  pid?: string;
  id?: string;
  /** Product name, English — `nameEn` on listV2. */
  nameEn?: string;
  /** Product name, English — legacy `nameen` spelling on older endpoints. */
  nameen?: string;
  /** Product name, Chinese. */
  name?: string;
  productNameEn?: string;
  /** Product main image, a single URL — the documented listV2 field. */
  bigImage?: string;
  /** Image list, as returned by the older list endpoints. */
  newImgList?: string[];
  /** Single image field used by the older list endpoint. */
  productImage?: string;
  /**
   * CJ selling (cost-to-buy) price, decimal string. CJ documents `sellPrice`
   * (listV2) as a USD amount; `sellprice` is the legacy spelling.
   */
  sellPrice?: string | number;
  sellprice?: string | number;
  /** Promotional/discount price, decimal string. */
  nowPrice?: string | number;
  sku?: string;
  productSku?: string;
  spu?: string;
  categoryId?: string;
  categoryName?: string;
  /** Total inventory across warehouses, as published on the search summary. */
  warehouseInventoryNum?: number;
  /**
   * Variant list. listV2 does not return variants (per CJ's FAQ); the detail
   * endpoint does, so the row shape is left untyped here.
   */
  stanProducts?: unknown[];
  supplierName?: string;
  supplierNameEn?: string;
  [key: string]: unknown;
}

/**
 * `data` of the `GET /v1/product/listV2` collection.
 *
 * CJ documents the V2 page wrapper two levels deep: `content` is an array whose
 * elements expose `productList`. That nesting is unusual, so the adapter
 * (see `extractSearchProducts`) also tolerates `content` flattened into products
 * and the legacy `list` field, and never guesses a product count when CJ sends
 * neither (`totalRecords` is then reported as null).
 */
export interface CjProductListData {
  /** Documented V2 wrapper; each element carries a `productList`. */
  content?: Array<{ productList?: CjProduct[] } & CjProduct>;
  /** Total result-set size reported by listV2. */
  totalRecords?: number;
  totalPages?: number;
  pageNumber?: number;
  pageSize?: number;
  /** Legacy spellings kept so a response from an older endpoint still maps. */
  list?: CjProduct[];
  total?: number;
  count?: number;
}

/** `data` of the authentication endpoints. */
export interface CjTokenData {
  accessToken?: string;
  refreshToken?: string;
  /** Accepted defensively in case CJ switches to the OAuth2 snake_case form. */
  access_token?: string;
  refresh_token?: string;
}

/**
 * One warehouse-level stock row, as returned by the inventory endpoints
 * (`GET /v1/product/stock/queryBySku`, `.../queryByVid`). CJ exposes two stock
 * dimensions: stock it manages in its own warehouses (`cjInventory*`) and stock
 * held by the partner factory (`factoryInventory*`).
 */
export interface CjWarehouseInventory {
  areaEn?: string;
  areaId?: number | string;
  countryCode?: string;
  countryNameEn?: string;
  /** Legacy/alternate field name used on some rows. */
  storageNum?: number;
  totalInventoryNum?: number;
  cjInventoryNum?: number;
  factoryInventoryNum?: number;
  /** Per-sub-warehouse rows (variant-level responses). */
  inventory?: number;
  factoryInventory?: number;
  vid?: string;
}

/** Variant-level inventory grouping returned by product-level inventory calls. */
export interface CjVariantInventory {
  vid?: string;
  inventory?: CjWarehouseInventory[];
}

/**
 * One variant row from `GET /v1/product/variant/query` (and the `variants`
 * array of the product-detail endpoint). Field casing follows CJ's documented
 * response exactly; every field CJ marks optional stays optional here.
 */
export interface CjVariant {
  vid?: string;
  pid?: string;
  variantName?: string;
  variantNameEn?: string;
  variantSku?: string;
  barcode?: string;
  variantKey?: string;
  variantUnit?: string;
  variantWeight?: number | string;
  variantLength?: number | string;
  variantWidth?: number | string;
  variantHeight?: number | string;
  variantVolume?: number | string;
  /** Variant cost-to-buy price, decimal string or number. */
  variantSellPrice?: string | number;
  /** Suggested *retail* price — not a cost; never used as supplier cost. */
  variantSugSellPrice?: string | number;
  /** Per-warehouse stock for this variant. */
  inventories?: CjVariantWarehouseInventory[];
}

/**
 * One warehouse stock row inside a variant. CJ exposes total plus its two stock
 * dimensions (CJ-managed and partner-factory), mirroring `CjWarehouseInventory`
 * but with the variant endpoint's field names.
 */
export interface CjVariantWarehouseInventory {
  countryCode?: string;
  countryNameEn?: string;
  areaEn?: string;
  totalInventory?: number;
  cjInventory?: number;
  factoryInventory?: number;
  inventory?: number;
  factoryInventoryNum?: number;
}

/**
 * One shipping method returned by `POST /v1/logistic/freightCalculate`.
 * `logisticPrice` is the USD freight; `logisticAging` is CJ's transit-time
 * range (e.g. `"2-5"`); `logisticName` is the carrier/method.
 */
export interface CjFreightQuote {
  logisticPrice?: number | string;
  logisticPriceCn?: number | string;
  logisticAging?: string;
  logisticName?: string;
  taxesFee?: number | string;
  clearanceOperationFee?: number | string;
  totalPostageFee?: number | string;
}

/** Request body of `POST /v1/logistic/freightCalculate`. */
export interface CjFreightRequest {
  startCountryCode: string;
  endCountryCode: string;
  zip?: string;
  /** CJ quotes per variant, so a `vid` is required. */
  products: Array<{ quantity: number; vid: string }>;
}
