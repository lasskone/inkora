/**
 * Error vocabulary for the CJdropshipping integration.
 *
 * Mirrors the eBay error design: every failure mode that can reach the API
 * boundary has a dedicated class, so the route can translate it into a precise,
 * safe HTTP response without leaking upstream payloads or credentials. Error
 * messages never carry secrets, tokens, or raw upstream bodies. CJ's numeric
 * `code` is safe to surface (it is a fixed integer, not caller-controlled
 * prose) and is exactly what an operator needs to diagnose a rejection.
 */
export class CjConfigError extends Error {
  constructor(message = "CJdropshipping is not configured") {
    super(message);
    this.name = "CjConfigError";
  }
}

export class CjAuthError extends Error {
  /**
   * CJ's standardized numeric error code (e.g. the value of `code` in the
   * authentication envelope), when one was returned. A fixed public integer —
   * never a raw upstream description, and never a credential or token.
   */
  readonly code?: number;

  constructor(message = "CJdropshipping authentication failed", options?: { code?: number }) {
    super(message);
    this.name = "CjAuthError";
    this.code = options?.code;
  }
}

export class CjApiError extends Error {
  /** Upstream HTTP status, when one was received. */
  readonly status?: number;
  /** CJ envelope `code`, when one was returned. */
  readonly cjCode?: number;
  /** Whether repeating the identical request could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: { status?: number; cjCode?: number; retryable?: boolean },
  ) {
    super(message);
    this.name = "CjApiError";
    this.status = options?.status;
    this.cjCode = options?.cjCode;
    this.retryable = options?.retryable ?? false;
  }
}
