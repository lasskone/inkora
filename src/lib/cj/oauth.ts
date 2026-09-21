import "server-only";

import { requireCjConfig, type CjConfig } from "./config";
import { CjAuthError } from "./errors";
import type { CjEnvelope, CjTokenData } from "./types";

/**
 * CJdropshipping authentication.
 *
 * CJ's official API 2.0 authenticates with an API key issued by the account
 * (not the sign-in email/password): the application posts `{"apiKey": "..."}`
 * to `POST /v1/authentication/getAccessToken` and receives an access token plus
 * a refresh token, which are then sent on every subsequent call in the
 * `CJ-Access-Token` header.
 *
 * Token lifecycle: CJ's token envelope as modeled here does not publish an
 * `expires_in`, so expiry is handled *failure-driven* rather than by a clock:
 * the token is cached in-process and reused until CJ rejects it, at which point
 * a refresh (or, failing that, a fresh API-key authentication) happens
 * exactly once. This avoids unnecessary token requests while never using a
 * token CJ has revoked. Access and refresh tokens are confidential: they are
 * cached in-process only, never written to logs, and never returned to the
 * browser.
 */

const GET_TOKEN_PATH = "/v1/authentication/getAccessToken";
const REFRESH_TOKEN_PATH = "/v1/authentication/refreshAccessToken";
const TOKEN_TIMEOUT_MS = 15_000;

interface CachedCredentials {
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

/**
 * The cache is a module-level in-process variable — the simplest secure
 * mechanism appropriate to the current single-process Next.js server
 * architecture. No external dependency (Redis etc.) is introduced for token
 * caching at this stage; see docs/ARCHITECTURE.md.
 */
let cachedCredentials: CachedCredentials | null = null;

/**
 * Returns a usable CJ access token, requesting one only when there is no cached
 * credential. A token supplied by configuration (`CJ_TOKEN`) seeds the cache
 * once and is then subject to the same invalidation path.
 */
export async function getCjAccessToken(): Promise<string> {
  const config = requireCjConfig();

  if (cachedCredentials === null && config.staticAccessToken) {
    cachedCredentials = {
      accessToken: config.staticAccessToken,
      refreshToken: null,
    };
  }

  if (cachedCredentials !== null) {
    return cachedCredentials.accessToken;
  }

  cachedCredentials = await authenticate(config, null);
  return cachedCredentials.accessToken;
}

/** Drops the cached token so the next call re-authenticates. */
export function invalidateCjAccessToken(): void {
  cachedCredentials = null;
}

/**
 * Mints a fresh credential pair. Prefers the refresh-token grant when a refresh
 * token is available (cheaper, and it is the documented way to rotate an access
 * token); otherwise falls back to the API-key grant.
 */
async function authenticate(
  config: CjConfig,
  refreshToken: string | null,
): Promise<CachedCredentials> {
  const useRefresh = Boolean(refreshToken);
  const path = useRefresh ? REFRESH_TOKEN_PATH : GET_TOKEN_PATH;
  const body: Record<string, string> = useRefresh
    ? { refreshToken: refreshToken as string }
    : { apiKey: config.apiKey };

  const response = await postJson<CjEnvelope<CjTokenData>>(config, path, body);

  if (!response.ok || response.payload === null || response.payload.result === false) {
    // The upstream message is deliberately not surfaced verbatim; CJ's numeric
    // code is the safe, stable diagnostic an operator needs.
    const code = response.payload?.code;
    console.warn(
      `[cj/oauth] token request rejected (HTTP ${response.status}${typeof code === "number" ? `, code: ${code}` : ""}).`,
    );
    throw new CjAuthError(`CJ token request failed (HTTP ${response.status}).`, {
      code: typeof code === "number" ? code : undefined,
    });
  }

  const tokenData = response.payload.data;
  const accessToken = tokenData?.accessToken ?? tokenData?.access_token;
  const newRefreshToken = tokenData?.refreshToken ?? tokenData?.refresh_token ?? null;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new CjAuthError("CJ token response was malformed.");
  }

  return { accessToken, refreshToken: newRefreshToken };
}

async function postJson<T>(
  config: CjConfig,
  path: string,
  body: Record<string, string>,
): Promise<{ ok: boolean; status: number; payload: T | null }> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    // Network/timeout collapse to a single safe auth failure.
    throw new CjAuthError("CJ token request did not complete.");
  }

  const payload = await readJson<T>(response);
  return { ok: response.ok, status: response.status, payload };
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    const text = await response.text();
    if (text.length === 0) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
