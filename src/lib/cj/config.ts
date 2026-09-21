import "server-only";

import { CjConfigError } from "./errors";

/**
 * CJdropshipping environment selection.
 *
 * The official CJ API 2.0 gateway is the single production base URL; unlike
 * eBay there is no separate sandbox host in the documented contract. The base
 * URL is overridable by configuration (`CJ_API_BASE_URL`) so tests can point at
 * a different gateway without editing code — but by default it is the real,
 * production CJ endpoint, and nothing in this module ever substitutes a mock.
 */
export const DEFAULT_CJ_BASE_URL = "https://developers.cjdropshipping.com/api2.0";

/**
 * The header CJ requires on every authenticated request. Named here so the
 * string lives in exactly one place, and so it is obvious this is a
 * provider-specific detail that must not leak into the common supplier model.
 */
export const CJ_TOKEN_HEADER = "CJ-Access-Token";

export interface CjConfig {
  baseUrl: string;
  /**
   * The CJdropshipping API key (`CJ_API_KEY`). CJ's official API 2.0
   * authentication accepts *only* this value — not the account sign-in
   * email/password.
   */
  apiKey: string;
  /**
   * Optional access token supplied directly via `CJ_TOKEN`. When present it
   * seeds the in-process cache and is used until CJ rejects it, at which point
   * the adapter re-authenticates with the API key.
   */
  staticAccessToken: string | null;
}

/**
 * Resolves the CJ configuration from the environment.
 *
 * Returns `null` (rather than throwing) when the integration cannot be used at
 * all, so callers can produce a clean "not configured" response instead of
 * crashing the request. Only variable *names* are ever referenced in messages
 * or logs — credential values are never read into logs or responses.
 *
 * Variable naming follows the project template in `.env.example`.
 */
export function resolveCjConfig(): CjConfig | null {
  const apiKey = (process.env.CJ_API_KEY ?? "").trim();
  const staticAccessToken = (process.env.CJ_TOKEN ?? "").trim() || null;
  const baseUrl = (process.env.CJ_API_BASE_URL ?? "").trim() || DEFAULT_CJ_BASE_URL;

  // Usable when we can authenticate on demand, or when a token is supplied
  // outright. Without either, there is no honest way to call the CJ API.
  if (!apiKey && !staticAccessToken) {
    return null;
  }

  return {
    baseUrl,
    apiKey,
    staticAccessToken,
  };
}

/**
 * Asserts the integration is usable, throwing a clear, secret-free error when
 * it is not.
 */
export function requireCjConfig(): CjConfig {
  const config = resolveCjConfig();
  if (config === null) {
    throw new CjConfigError(
      "CJ_API_KEY must be configured (see .env.example).",
    );
  }
  return config;
}
