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
  constructor(message = "eBay authentication failed") {
    super(message);
    this.name = "EbayAuthError";
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
