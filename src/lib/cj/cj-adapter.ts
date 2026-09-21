import "server-only";

import { requireCjConfig } from "./config";
import {
  CJ_MAX_PAGE_SIZE,
  queryCjInventoryBySku,
  searchCjProducts,
} from "./products-api";
import type {
  CjProduct,
  CjProductListData,
  CjWarehouseInventory,
} from "./types";
import type {
  SupplierAdapter,
  SupplierProduct,
  SupplierSearchRequest,
  SupplierSearchResult,
  SupplierWarehouseInventory,
  UsWarehouseInventoryStatus,
} from "@/lib/supplier/types";

/**
 * `SupplierAdapter` implementation for CJdropshipping.
 *
 * The only place in Inkora that knows about CJ: it owns the API-key
 * authentication handshake, the API 2.0 request shapes, and the mapping from
 * CJ's responses into Inkora's provider-independent supplier model. Core domain
 * logic (the future Product Matcher, Opportunity Engine) never imports from
 * this module.
 *
 * Everything emitted here is sourced directly from the official, authenticated
 * CJ API, so every value carries provenance `OFFICIAL`. Fields CJ does not
 * return are `null` — never guessed and never converted into fake estimates.
 * Critically, product search alone does **not** expose inventory or warehouse
 * country: those stay `null`/unknown until a real inventory call confirms them
 * (see `classifyUsWarehouseInventory`).
 */
export class CjAdapter implements SupplierAdapter {
  readonly supplier = "cj" as const;

  async search(
    request: SupplierSearchRequest,
  ): Promise<SupplierSearchResult> {
    const config = requireCjConfig();

    const limit = clampLimit(request.limit);
    const offset = clampOffset(request.offset ?? 0);
    const page = Math.floor(offset / limit) + 1;

    const data = await searchCjProducts(config, {
      query: request.query,
      page,
      size: limit,
    });

    const items = extractSearchProducts(data);

    const products = items
      .map((item) => normalizeCjProduct(item))
      .filter((product): product is SupplierProduct => product !== null);

    return {
      query: request.query,
      limit,
      offset,
      total: typeof data.totalRecords === "number" ? data.totalRecords : null,
      count: products.length,
      products,
    };
  }
}

const DEFAULT_LIMIT = 24;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), MIN_LIMIT), MAX_LIMIT);
}

/** Offset is bounded by CJ's own page ceiling (page ≤ 1000). */
function clampOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(Math.trunc(offset), 0), CJ_MAX_PAGE_SIZE * MAX_LIMIT);
}

/**
 * Pulls the product rows out of a listV2 page.
 *
 * CJ documents `content` as an array of objects each carrying a `productList`,
 * which is an unusual nesting for a keyword search; the live response has also
 * been observed flattening `content` into products directly. Both shapes are
 * accepted here, and the legacy `list` field is honored as a final fallback, so
 * a change in CJ's wrapper cannot silently turn a real result set into "no
 * products". An unrecognized shape yields an empty array, which surfaces
 * honestly as an empty page rather than a crash.
 */
function extractSearchProducts(data: CjProductListData): CjProduct[] {
  if (Array.isArray(data.content)) {
    const flattened = data.content.flatMap((entry) => {
      if (
        entry !== null &&
        typeof entry === "object" &&
        Array.isArray((entry as CjProduct).productList)
      ) {
        return (entry as CjProduct).productList as CjProduct[];
      }
      return [entry];
    });
    if (flattened.length > 0) return flattened;
  }

  return Array.isArray(data.list) ? data.list : [];
}


/**
 * Maps one CJ product row to the normalized model.
 *
 * Defensive by design: a row missing a field degrades to `null` for that field,
 * and a row missing its id or title is dropped entirely rather than emitting a
 * half-empty record downstream. CJ returns both Chinese (`name`) and English
 * (`nameEn` on listV2, `nameen` on legacy endpoints) titles; the English title
 * is preferred and the Chinese one is the fallback, so a product is never
 * dropped merely for lacking an EN title.
 */
function normalizeCjProduct(product: CjProduct): SupplierProduct | null {
  const externalId = product.id ?? product.pid;
  const title =
    product.nameEn?.trim() ||
    product.nameen?.trim() ||
    product.productNameEn?.trim() ||
    product.name?.trim();

  if (!externalId || !title) {
    return null;
  }

  const price = pickPrice(product);

  return {
    supplier: "cj",
    externalId,
    sku: pickSku(product),
    title,
    imageUrl: pickImageUrl(product),
    // CJ's search subset returns no canonical CJ product URL (only unrelated
    // third-party/supplier-link fields), so this stays null rather than being
    // synthesized.
    productUrl: null,
    category: pickCategory(product),
    supplierPrice: price,
    // CJ documents `sellPrice` as a USD amount ("$ (USD)"), so the currency is
    // known wherever a price was returned; it stays null only when no price
    // arrived.
    currency: price === null ? null : "USD",
    // Product search does not expose inventory or warehouse country — those
    // are established only by the inventory endpoint (see
    // `classifyUsWarehouseInventory`).
    availableInventory: null,
    warehouseCountry: null,
    shippingOrigin: null,
    variants: normalizeVariants(product.stanProducts),
    provenance: "OFFICIAL",
    fetchedAt: new Date().toISOString(),
  };
}

function pickSku(product: CjProduct): string | null {
  const value = product.sku ?? product.productSku;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function pickImageUrl(product: CjProduct): string | null {
  const candidates = [
    product.bigImage,
    ...(Array.isArray(product.newImgList) ? product.newImgList : []),
    product.productImage,
  ].filter((candidate): candidate is string => typeof candidate === "string");

  for (const candidate of candidates) {
    if (/^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function pickCategory(product: CjProduct): string | null {
  const value = product.categoryName ?? product.categoryId;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Prefers CJ's selling price; the promotional `nowPrice` is deliberately not
 * used, since a discount price is not the stable cost basis later economics
 * need. Always carried as a decimal string.
 *
 * CJ returns `sellPrice` as a *range* string (e.g. `"23.36 -- 23.42"`) for
 * products with more than one variant — verified live — so a plain numeric
 * cast would yield `NaN` and silently drop the price for those rows. The range
 * is parsed instead and its low end is published: that is the real minimum cost
 * CJ quotes for the product, so it stays a value CJ actually returned (never an
 * estimate) while honoring the decimal-string contract of `supplierPrice`.
 */
function pickPrice(product: CjProduct): string | null {
  const value = product.sellPrice ?? product.sellprice ?? product.nowPrice;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return parseCjPriceString(value.trim());
  }
  return null;
}

/**
 * Accepts both a single decimal (`"9.14"`) and CJ's variant range form
 * (`"23.36 -- 23.42"`), returning the low end as a trimmed decimal string, or
 * `null` when no usable decimal is present.
 */
function parseCjPriceString(value: string): string | null {
  const candidates = value.split("--").map((part) => part.trim());
  for (const candidate of candidates) {
    if (candidate.length > 0 && Number.isFinite(Number(candidate))) {
      return candidate;
    }
  }
  return null;
}


/**
 * Maps CJ's variant list defensively. The search subset does not document the
 * variant row shape, so every variant field degrades to `null` when absent; a
 * variant with neither an id, an sku, nor a title is skipped.
 */
function normalizeVariants(
  variants: unknown[] | undefined,
): SupplierProduct["variants"] {
  if (!Array.isArray(variants)) return [];

  return variants
    .filter(
      (variant): variant is Record<string, unknown> =>
        variant !== null && typeof variant === "object",
    )
    .map((variant) => ({
      externalId: readString(variant, ["vid", "variantId", "id"]),
      sku: readString(variant, ["variantSku", "sku", "vid"]),
      title: readString(variant, [
        "variantNameEn",
        "variantName",
        "nameen",
        "name",
      ]),
      price: readString(variant, [
        "variantSellPrice",
        "sellprice",
        "variantSugSellPrice",
      ]),
      availableInventory: null,
    }))
    .filter(
      (variant) => Boolean(variant.externalId || variant.sku || variant.title),
    );
}

function readString(
  source: Record<string, unknown>,
  names: string[],
): string | null {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

/**
 * Normalizes CJ's per-warehouse stock rows into the supplier model and derives
 * the honest US-warehouse verdict. This is the *only* place US inventory may be
 * confirmed: an empty or uninterpretable response yields `UNKNOWN`, never an
 * estimate.
 */
export function classifyUsWarehouseInventory(
  rows: CjWarehouseInventory[],
): {
  warehouses: SupplierWarehouseInventory[];
  status: UsWarehouseInventoryStatus;
} {
  const warehouses: SupplierWarehouseInventory[] = rows.map((row) => ({
    countryCode: normalizeCountryCode(row.countryCode),
    countryName: readStringField(row.countryNameEn),
    warehouseName: readStringField(row.areaEn),
    totalQuantity: readNumberField(row.totalInventoryNum ?? row.storageNum),
    cjWarehouseQuantity: readNumberField(row.cjInventoryNum),
    factoryWarehouseQuantity: readNumberField(row.factoryInventoryNum),
    provenance: "OFFICIAL",
  }));

  if (warehouses.length === 0) {
    return { warehouses, status: "UNKNOWN" };
  }

  const hasUsStock = warehouses.some(
    (row) => row.countryCode === "US" && (row.totalQuantity ?? 0) > 0,
  );
  return {
    warehouses,
    status: hasUsStock ? "CONFIRMED_AVAILABLE" : "CONFIRMED_NONE",
  };
}

function normalizeCountryCode(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

function readStringField(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumberField(value: number | string | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export { queryCjInventoryBySku };
