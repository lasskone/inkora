import "server-only";

import { EbayConfigError } from "./errors";

/**
 * eBay environment selection.
 *
 * The active environment is chosen purely by configuration (`EBAY_ENV`), never
 * by editing code, per docs/API_INTEGRATIONS.md. Sandbox and production have
 * distinct base URLs and token endpoints; production data is never silently
 * substituted for sandbox data or vice versa.
 */
export type EbayEnvironment = "production" | "sandbox";

const PRODUCTION_BASE_URL = "https://api.ebay.com";
const SANDBOX_BASE_URL = "https://api.sandbox.ebay.com";

/**
 * Default OAuth scope for the Browse API search method.
 */
export const DEFAULT_EBAY_SCOPE =
  "https://api.ebay.com/oauth/api_scope.buy.item.summary";

/**
 * Fallback scope, used only if eBay explicitly rejects the default scope for
 * this keyset under the client-credentials grant. The plain public scope is
 * accepted by every approved keyset.
 */
export const FALLBACK_EBAY_SCOPE = "https://api.ebay.com/oauth/api_scope";

/**
 * The Browse API is multi-site; the `X-EBAY-C-MARKETPLACE-ID` header pins the
 * site. EBAY_US keeps this slice aligned with the US-focused sourcing strategy
 * (see docs/API_INTEGRATIONS.md — "US warehouses").
 */
export const DEFAULT_EBAY_MARKETPLACE_ID = "EBAY_US";

export interface EbayConfig {
  environment: EbayEnvironment;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  marketplaceId: string;
}

/**
 * Resolves the eBay configuration from the environment.
 *
 * Returns `null` (rather than throwing) when the required client credentials are
 * absent, so callers can produce a clean "not configured" response instead of
 * crashing the request. Only variable *names* are ever referenced in messages or
 * logs — credential values are never read into logs or responses.
 */
export function resolveEbayConfig(): EbayConfig | null {
  const environment: EbayEnvironment =
    (process.env.EBAY_ENV ?? "").toLowerCase() === "production"
      ? "production"
      : "sandbox";

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  const scope = (process.env.EBAY_SCOPE ?? "").trim() || DEFAULT_EBAY_SCOPE;

  return {
    environment,
    baseUrl:
      environment === "production" ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL,
    clientId,
    clientSecret,
    scope,
    marketplaceId: DEFAULT_EBAY_MARKETPLACE_ID,
  };
}

/**
 * Asserts the integration is usable, throwing a clear, secret-free error when it
 * is not.
 */
export function requireEbayConfig(): EbayConfig {
  const config = resolveEbayConfig();
  if (config === null) {
    throw new EbayConfigError(
      "EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be configured (see .env.example).",
    );
  }
  return config;
}
