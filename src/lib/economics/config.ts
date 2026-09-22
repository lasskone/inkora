import "server-only";

/**
 * Documented, configurable shipping baseline for economics.
 *
 * CJ quotes freight for a *specific* destination, and a quote to one address is
 * not a universal shipping guarantee. V1 therefore compares every candidate
 * against one explicitly documented baseline destination, resolved here from
 * configuration rather than buried inside the calculation (docs/ARCHITECTURE.md
 * §10.1, docs/API_INTEGRATIONS.md §3.8).
 *
 * The baseline intentionally collects nothing more than a country and an optional
 * postal code — no name, street, or other personal-address data.
 */

/** Country used when configuration does not select one. */
export const DEFAULT_DESTINATION_COUNTRY = "US";

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const MAX_POSTAL_LENGTH = 20;

export interface ShippingBaseline {
  /** ISO 3166-1 alpha-2 destination country code. */
  countryCode: string;
  /** Postal code sent to the supplier, or `null` when none is configured. */
  postalCode: string | null;
  /** Human-readable label for the UI. */
  label: string;
}

/**
 * Resolves the baseline destination from the environment.
 *
 * Never throws: an unusable value falls back to the documented default, and the
 * caller always receives a valid, displayable baseline.
 *
 * - `INKORA_ECONOMICS_DESTINATION_COUNTRY` — ISO 3166-1 alpha-2 (default `US`)
 * - `INKORA_ECONOMICS_DESTINATION_POSTAL`  — optional postal code
 */
export function resolveShippingBaseline(): ShippingBaseline {
  const rawCountry = (process.env.INKORA_ECONOMICS_DESTINATION_COUNTRY ?? "")
    .trim()
    .toUpperCase();
  const countryCode = COUNTRY_CODE_PATTERN.test(rawCountry)
    ? rawCountry
    : DEFAULT_DESTINATION_COUNTRY;

  const rawPostal = (process.env.INKORA_ECONOMICS_DESTINATION_POSTAL ?? "")
    .trim()
    .slice(0, MAX_POSTAL_LENGTH);
  const postalCode = rawPostal.length > 0 ? rawPostal : null;

  return {
    countryCode,
    postalCode,
    label: `baseline destination ${countryCode}${postalCode ? ` ${postalCode}` : ""}`,
  };
}
