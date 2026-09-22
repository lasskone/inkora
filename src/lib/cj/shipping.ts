import "server-only";

import { type CjConfig } from "./config";
import { quoteCjFreight } from "./logistics-api";
import { queryCjVariants } from "./variants-api";
import type { CjFreightQuote, CjVariant } from "./types";
import type {
  ShippingQuote,
  SupplierVariant,
} from "@/lib/supplier/types";
import { formatCents, parseDecimalToCents } from "@/lib/economics/money";
import {
  selectShippingQuote,
  selectSupplierVariant,
  type VariantSelection,
} from "@/lib/economics/selection";

/**
 * Isolated CJ shipping-quote service (docs/ARCHITECTURE.md §10.4).
 *
 * This is the *only* module that turns a matched CJ candidate into shipping
 * economics inputs. It keeps every external CJ logistics call away from the UI
 * and away from the economics formulas:
 *
 * ```text
 *   CJ variant/query  → normalized variants → deterministic variant selection
 *   CJ freight calc   → normalized ShippingQuote[] → deterministic quote choice
 * ```
 *
 * Nothing here invents a cost. No variants ⇒ no quote ⇒ economics stay
 * incomplete. No freight methods ⇒ no quote ⇒ economics stay incomplete.
 *
 * Call budget per request: **1** variant query + **1–2** freight calculations
 * (the second only when a destination-warehouse origin yields no methods and the
 * fallback origin differs). Bounded, documented, predictable.
 */

/** Default origin when no warehouse country is confirmed for the variant. */
const DEFAULT_ORIGIN_COUNTRY = "CN";

export interface CjShippingRequest {
  /** CJ product id (`SupplierProduct.externalId`) — an opaque lookup key. */
  pid: string;
  destinationCountry: string;
  destinationPostalCode: string | null;
  /** Order size quoted; V1 economics model a single-unit order. */
  quantity: number;
}

/** Everything the economics engine needs from the supplier side. */
export interface CjShippingOutcome {
  variants: SupplierVariant[];
  selectedVariant: VariantSelection | null;
  quotes: ShippingQuote[];
  selectedQuote: ShippingQuote | null;
  /** Origin country actually sent to CJ. */
  originCountry: string;
  /** Human-readable caveats for the caller to surface as warnings. */
  notes: string[];
}


/**
 * Resolves variants for a CJ product and quotes shipping to the destination.
 *
 * Failures are reported, never papered over: a product with no usable variants
 * returns `selectedVariant: null`, and a product whose variants cannot be quoted
 * returns `selectedQuote: null`. Both lead the economics layer to an explicit
 * incomplete result.
 */
export async function quoteCjShipping(
  config: CjConfig,
  request: CjShippingRequest,
): Promise<CjShippingOutcome> {
  const variants = await resolveVariants(config, request.pid);

  const selection = selectSupplierVariant(variants, request.destinationCountry);
  const notes: string[] = [];
  if (selection === null) {
    notes.push(
      variants.length === 0
        ? "The supplier product returned no variants, so its specific cost and shipping cannot be determined."
        : "The supplier product returned no variant with an id and a price, so its specific cost and shipping cannot be determined.",
    );
    return {
      variants,
      selectedVariant: null,
      quotes: [],
      selectedQuote: null,
      originCountry: DEFAULT_ORIGIN_COUNTRY,
      notes,
    };
  }

  notes.push(...selection.warnings);

  const stockedCountries = selection.variant.warehouseCountries ?? [];
  const preferredOrigin = stockedCountries.includes(request.destinationCountry)
    ? request.destinationCountry
    : DEFAULT_ORIGIN_COUNTRY;

  const vid = selection.variant.externalId as string;
  const freight = await quoteFreight(config, request, vid, preferredOrigin);
  let quotes = normalizeQuotes(freight, preferredOrigin);
  let originCountry = preferredOrigin;

  // A destination-warehouse origin is only a hint; if CJ cannot quote it, fall
  // back to the default origin exactly once rather than reporting "no shipping".
  if (quotes.length === 0 && preferredOrigin !== DEFAULT_ORIGIN_COUNTRY) {
    const fallback = await quoteFreight(config, request, vid, DEFAULT_ORIGIN_COUNTRY);
    quotes = normalizeQuotes(fallback, DEFAULT_ORIGIN_COUNTRY);
    originCountry = DEFAULT_ORIGIN_COUNTRY;
  }

  const selectedQuote = selectShippingQuote(quotes);
  if (selectedQuote === null) {
    notes.push(
      quotes.length === 0
        ? "CJ returned no shipping methods for this variant and destination, so shipping cost is unknown."
        : "CJ returned shipping methods, but none carried a usable price, so shipping cost is unknown.",
    );
  }

  return {
    variants,
    selectedVariant: selection,
    quotes,
    selectedQuote,
    originCountry,
    notes,
  };
}

async function resolveVariants(config: CjConfig, pid: string): Promise<SupplierVariant[]> {
  const rows = await queryCjVariants(config, pid);
  return rows
    .map(normalizeVariant)
    .filter((variant): variant is SupplierVariant => variant !== null);
}

function normalizeVariant(variant: CjVariant): SupplierVariant | null {
  const externalId = trimString(variant.vid);
  if (!externalId) return null;

  const stock = summarizeStock(variant.inventories ?? []);

  return {
    externalId,
    sku: trimString(variant.variantSku),
    title: trimString(variant.variantNameEn) ?? trimString(variant.variantName),
    price: toDecimalString(variant.variantSellPrice),
    availableInventory: stock.totalUnits,
    warehouseCountries: stock.countries,
  };
}

function summarizeStock(rows: NonNullable<CjVariant["inventories"]>): {
  totalUnits: number;
  countries: string[];
} {
  let totalUnits = 0;
  const countries = new Set<string>();

  for (const row of rows ?? []) {
    const total = readNumber(row.totalInventory ?? row.inventory);
    const code = readCountryCode(row.countryCode);

    if (total !== null) {
      totalUnits += total;
      if (total > 0 && code !== null) countries.add(code);
    }
  }

  return { totalUnits, countries: [...countries].sort() };
}

function normalizeQuotes(rows: CjFreightQuote[], originCountry: string): ShippingQuote[] {
  return rows
    .map((row): ShippingQuote | null => {
      const method = trimString(row.logisticName);
      if (!method) return null;
      return {
        method,
        cost: toDecimalString(row.logisticPrice),
        currency: "USD",
        transitTime: trimString(row.logisticAging),
        originCountry,
        provenance: "OFFICIAL",
      };
    })
    .filter((quote): quote is ShippingQuote => quote !== null);
}

async function quoteFreight(
  config: CjConfig,
  request: CjShippingRequest,
  vid: string,
  originCountry: string,
): Promise<CjFreightQuote[]> {
  return quoteCjFreight(config, {
    startCountryCode: originCountry,
    endCountryCode: request.destinationCountry,
    ...(request.destinationPostalCode
      ? { zip: request.destinationPostalCode }
      : {}),
    products: [{ quantity: request.quantity, vid }],
  });
}

/** Canonicalizes a CJ numeric value to a two-decimal string, or `null`. */
function toDecimalString(value: string | number | undefined): string | null {
  const cents = parseDecimalToCents(value ?? null);
  return cents === null ? null : formatCents(cents);
}

function trimString(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: number | string | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readCountryCode(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}
