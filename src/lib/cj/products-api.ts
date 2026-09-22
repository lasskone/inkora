import "server-only";

import { type CjConfig } from "./config";
import { cjGet } from "./http";
import type {
  CjProductListData,
  CjVariantInventory,
  CjWarehouseInventory,
} from "./types";

/**
 * Minimal client for the subset of the official CJ API 2.0 this slice needs.
 *
 *   GET /v1/product/listV2           — keyword product search (Elasticsearch)
 *   GET /v1/product/stock/queryBySku — inventory by SKU, per warehouse
 *
 * This layer talks raw HTTP and returns the raw (typed-subset) payload. It
 * performs **no** normalization — mapping into Inkora's model is the adapter's
 * responsibility, so CJ specifics stay behind this boundary.
 *
 * Transport (timeouts, backoff, token refresh, envelope checking) is shared with
 * the other CJ endpoints in `./http`.
 */

const SEARCH_PATH = "/v1/product/listV2";
const INVENTORY_BY_SKU_PATH = "/v1/product/stock/queryBySku";

/** CJ's published page-size ceiling for listV2. */
export const CJ_MAX_PAGE_SIZE = 100;

export interface CjSearchOptions {
  readonly query: string;
  /** CJ `page` is 1-based. */
  readonly page: number;
  readonly size: number;
}

/**
 * Calls the official CJ product search with bounded retries
 * (see ./http for the resilience policy).
 */
export async function searchCjProducts(
  config: CjConfig,
  options: CjSearchOptions,
): Promise<CjProductListData> {
  const params = new URLSearchParams({
    keyWord: options.query,
    page: String(options.page),
    size: String(options.size),
  });
  const url = `${config.baseUrl}${SEARCH_PATH}?${params.toString()}`;

  return cjGet<CjProductListData>(config, url);
}

/**
 * Queries per-warehouse inventory for a single SKU — the narrow, additional
 * official endpoint used to establish warehouse country (incl. US stock) for a
 * selected product. See docs/API_INTEGRATIONS.md §3.
 */
export async function queryCjInventoryBySku(
  config: CjConfig,
  sku: string,
): Promise<CjWarehouseInventory[]> {
  const url = `${config.baseUrl}${INVENTORY_BY_SKU_PATH}?${new URLSearchParams({ sku }).toString()}`;
  const data = await cjGet<unknown>(config, url);
  return extractWarehouseRows(data);
}

/**
 * CJ's inventory endpoints answer with one of several documented shapes
 * depending on the endpoint and version — a bare array of warehouse rows, an
 * object of `inventories`, or variant-grouped `variantInventories`. All are
 * accepted here; an unrecognized shape yields an empty array, which the caller
 * honestly reports as inventory UNKNOWN rather than guessing a quantity.
 */
function extractWarehouseRows(data: unknown): CjWarehouseInventory[] {
  if (Array.isArray(data)) {
    return data.filter((row): row is CjWarehouseInventory => isObjectRow(row));
  }

  if (data !== null && typeof data === "object") {
    const value = data as Record<string, unknown>;

    if (Array.isArray(value.inventories)) {
      return value.inventories.filter(
        (row): row is CjWarehouseInventory => isObjectRow(row),
      );
    }

    if (Array.isArray(value.variantInventories)) {
      return (value.variantInventories as CjVariantInventory[])
        .flatMap((variant) =>
          Array.isArray(variant.inventory) ? variant.inventory : [],
        )
        .filter((row): row is CjWarehouseInventory => isObjectRow(row));
    }
  }

  return [];
}

function isObjectRow(value: unknown): boolean {
  return value !== null && typeof value === "object";
}
