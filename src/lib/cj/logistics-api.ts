import "server-only";

import { type CjConfig } from "./config";
import { cjPost } from "./http";
import type { CjFreightQuote, CjFreightRequest } from "./types";

/**
 * Official CJ freight calculation.
 *
 *   POST /v1/logistic/freightCalculate
 *
 * This is the *only* source of shipping cost in Inkora's economics: CJ quotes
 * freight for a specific variant id, destination country and quantity, and
 * returns one row per eligible shipping method (`logisticName`) with its USD
 * price (`logisticPrice`) and transit-time range (`logisticAging`).
 *
 * Inkora never invents, scrapes, or hardcodes a shipping figure. When this call
 * returns no usable rows — or CJ rejects the trial calculation — economics stay
 * incomplete rather than substituting an assumed cost
 * (docs/ARCHITECTURE.md §10.4, docs/API_INTEGRATIONS.md §3.8).
 *
 * Required by CJ: `startCountryCode`, `endCountryCode`, and one product row with
 * `quantity` and `vid`. Missing any of them, CJ answers `1600300`.
 */
const FREIGHT_CALCULATE_PATH = "/v1/logistic/freightCalculate";

export async function quoteCjFreight(
  config: CjConfig,
  request: CjFreightRequest,
): Promise<CjFreightQuote[]> {
  const data = await cjPost<unknown>(config, FREIGHT_CALCULATE_PATH, request);
  return extractFreightQuotes(data);
}

/**
 * CJ returns the method list directly as an array. An unrecognized or empty
 * shape yields an empty array — reported honestly as "no shipping quote
 * available", never as a zero cost.
 */
function extractFreightQuotes(data: unknown): CjFreightQuote[] {
  if (Array.isArray(data)) {
    return data.filter((row): row is CjFreightQuote => row !== null && typeof row === "object");
  }

  if (data !== null && typeof data === "object") {
    const value = data as Record<string, unknown>;
    if (Array.isArray(value.data)) {
      return value.data.filter(
        (row): row is CjFreightQuote => row !== null && typeof row === "object",
      );
    }
  }

  return [];
}
