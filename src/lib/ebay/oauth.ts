import "server-only";

import {
  FALLBACK_EBAY_SCOPE,
  requireEbayConfig,
  type EbayConfig,
} from "./config";
import { EbayAuthError } from "./errors";
import type { EbayApplicationAccessToken, EbayOAuthError } from "./types";

/**
 * eBay authentication — OAuth2 **client-credentials grant**.
 *
 * Inkora searches active eBay inventory as the *application* itself (the Browse
 * API `item_summary/search` method accepts an Application access token), so no
 * user-consent flow is required for this slice. See docs/API_INTEGRATIONS.md.
 *
 * Access tokens are confidential. They are cached in-process only, are never
 * written to logs, and are never returned to the browser.
 */

const TOKEN_PATH = "/identity/v1/oauth2/token";
const TOKEN_TIMEOUT_MS = 10_000;
/** Refresh slightly early so a token never expires mid-request. */
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

interface CachedToken {
  readonly accessToken: string;
  /** Epoch milliseconds after which the token must be treated as stale. */
  readonly expiresAt: number;
}

/**
 * The cache is a module-level in-process variable — the simplest secure
 * mechanism appropriate to the current single-process Next.js server
 * architecture. No external dependency (Redis etc.) is introduced for token
 * caching at this stage; see docs/ARCHITECTURE.md.
 */
let cachedToken: CachedToken | null = null;

/**
 * Returns a usable eBay application access token, requesting a new one only when
 * there is no cached token or the cached one is about to expire.
 */
export async function getEbayApplicationAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken !== null && now < cachedToken.expiresAt) {
    return cachedToken.accessToken;
  }

  const config = requireEbayConfig();
  const token = await requestApplicationAccessToken(config, config.scope);
  cachedToken = token;
  return token.accessToken;
}

/** Drops the cached token so the next call mints a fresh one. */
export function invalidateEbayAccessToken(): void {
  cachedToken = null;
}

async function requestApplicationAccessToken(
  config: EbayConfig,
  scope: string,
): Promise<CachedToken> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope,
  });

  const response = await postForm(
    `${config.baseUrl}${TOKEN_PATH}`,
    config,
    body,
  );
  const status = response.status;

  if (!response.ok) {
    const errorBody = await readJson<EbayOAuthError>(response).catch(
      () => null,
    );

    // A keyset may not be entitled to the buy.item.summary scope under the
    // client-credentials grant. Fall back exactly once to the plain public
    // scope, which every approved keyset accepts. Logged without secret values.
    if (
      status === 400 &&
      errorBody?.error === "invalid_scope" &&
      scope !== FALLBACK_EBAY_SCOPE
    ) {
      console.warn(
        "[ebay/oauth] requested scope rejected; retrying with the default public scope.",
      );
      return requestApplicationAccessToken(config, FALLBACK_EBAY_SCOPE);
    }

    // Deliberately generic: the upstream error is never surfaced verbatim, and
    // the credential is never echoed.
    throw new EbayAuthError(`eBay token request failed (HTTP ${status}).`);
  }

  const token = await readJson<EbayApplicationAccessToken>(response);
  if (
    token === null ||
    typeof token.access_token !== "string" ||
    typeof token.expires_in !== "number"
  ) {
    throw new EbayAuthError("eBay token response was malformed.");
  }

  return {
    accessToken: token.access_token,
    expiresAt:
      Date.now() +
      Math.max(token.expires_in, 0) * 1000 -
      EXPIRY_SAFETY_MARGIN_MS,
  };
}

async function postForm(
  url: string,
  config: EbayConfig,
  body: URLSearchParams,
): Promise<Response> {
  const credentials = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
  ).toString("base64");

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    const text = await response.text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
