import "server-only";

import { type CjConfig } from "./config";
import { cjGet } from "./http";
import type { CjVariant } from "./types";

/**
 * Variant resolution for CJ.
 *
 *   GET /v1/product/variant/query?pid=<pid>
 *
 * CJ's freight calculation is keyed on a *variant* id (`vid`), not a SKU, so a
 * candidate from the search endpoint (which lists no variants) must be resolved
 * to its variants before any shipping quote is possible. This endpoint returns
 * the variant list with per-variant cost, weight and per-warehouse stock.
 *
 * `pid` is the product id Inkora already carries as `SupplierProduct.externalId`
 * — it is treated purely as an opaque lookup key and never interpolated into a
 * URL or upstream query.
 */
const VARIANT_QUERY_PATH = "/v1/product/variant/query";

export async function queryCjVariants(
  config: CjConfig,
  pid: string,
): Promise<CjVariant[]> {
  const params = new URLSearchParams({ pid });
  const data = await cjGet<unknown>(
    config,
    `${config.baseUrl}${VARIANT_QUERY_PATH}?${params.toString()}`,
  );
  return extractVariants(data);
}

/**
 * CJ's variant endpoints can answer with a bare array or wrap the array one level
 * deep. Both are accepted; an unrecognized shape yields an empty array, which
 * the caller honestly reports as "variant unresolved" rather than guessing.
 */
function extractVariants(data: unknown): CjVariant[] {
  if (Array.isArray(data)) {
    return data.filter((row): row is CjVariant => isObjectRow(row));
  }

  if (data !== null && typeof data === "object") {
    const value = data as Record<string, unknown>;
    for (const field of ["data", "variants", "list"] as const) {
      if (Array.isArray(value[field])) {
        return value[field].filter((row): row is CjVariant => isObjectRow(row));
      }
    }
  }

  return [];
}

function isObjectRow(value: unknown): boolean {
  return value !== null && typeof value === "object";
}
