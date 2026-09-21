/**
 * Error vocabulary for the eBay integration.
 *
 * Every failure mode that can reach the API boundary has a dedicated class, so
 * the route can translate it into a precise, safe HTTP response without leaking
 * upstream payloads or credentials. Error messages never carry secrets, tokens,
 * or raw upstream bodies.
 */
export class EbayConfigError extends Error {
  constructor(message = "eBay is not configured") {
    super(message);
    this.name = "EbayConfigError";
  }
}

export class EbayAuthError extends Error {
  /**
   * Safe, standardized upstream error identifier (e.g. `invalid_client`), when
   * eBay returned one. This is a fixed public OAuth2 code (RFC 6749 §5.2), never
   * a raw upstream description and never a credential or token.
   */
  readonly code?: string;

  constructor(
    message = "eBay authentication failed",
    options?: { code?: string },
  ) {
    super(message);
    this.name = "EbayAuthError";
    this.code = options?.code;
  }
}

export class EbayApiError extends Error {
  /** Upstream HTTP status, when one was received. */
  readonly status?: number;
  /** Whether repeating the identical request could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: { status?: number; retryable?: boolean },
  ) {
    super(message);
    this.name = "EbayApiError";
    this.status = options?.status;
    this.retryable = options?.retryable ?? false;
  }
}
