/**
 * Money primitives for deterministic economics.
 *
 * Financial math must never use binary floating point directly: `0.1 + 0.2 !==
 * 0.3`, and a profit figure that drifts by a fraction of a cent is not
 * reproducible. This module therefore works in **minor units** (integer US
 * cents, and 1/100ths of a percent for margins) and parses decimal strings by
 * hand so no float is ever introduced.
 *
 * Conventions (see docs/ARCHITECTURE.md §10):
 * - parse: a decimal string or number becomes integer cents, rounded half-up;
 * - arithmetic: integers only, with one explicit rounding point per operation;
 * - format: cents render back to a two-decimal string.
 * - rounding: **half up** (toward +∞), applied with integer division so the tie
 *   case is exact. Negative results round toward zero's side of the tie, which
 *   is the conservative direction for a loss.
 *
 * This module is pure (no `server-only`, no I/O) so the economics suite is
 * unit-testable with Node's built-in runner and no network.
 */

/**
 * Absolute upper bound (in cents) this module will ever represent: ten billion
 * dollars. Beyond it a price is not a single-item retail value, and refusing it
 * protects the integer arithmetic from ever leaving the safe integer range
 * (2^53 ≈ 9e15 cents).
 */
const MAX_ABSOLUTE_CENTS = 1_000_000_000_000;

const BASIS_POINTS_PER_PERCENT = 100;

/**
 * Parses a monetary value into integer cents, or `null` when it is absent or
 * cannot be interpreted.
 *
 * Accepts the shapes the adapters actually emit: decimal strings (`"29.99"`),
 * numbers (`29.99`), and CJ's documented price *ranges* (`"23.36 -- 23.42"`) —
 * for a range the first numeric token is used, which for the range above is the
 * low end. Unparseable input is `null`, never `0` and never a guess.
 */
export function parseDecimalToCents(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  const match = /-?\d*\.?\d+/.exec(text);
  if (match === null) return null;

  return decimalStringToCents(match[0]);
}

/**
 * Converts one already-isolated decimal token to cents. Keeps at most two
 * fractional digits, rounding half up on the third.
 */
function decimalStringToCents(decimal: string): number | null {
  const negative = decimal.startsWith("-");
  const body = negative ? decimal.slice(1) : decimal;
  const dotIndex = body.indexOf(".");
  const integerPart = dotIndex === -1 ? body : body.slice(0, dotIndex);
  const fractionalPart = dotIndex === -1 ? "" : body.slice(dotIndex + 1);

  if (!/^\d*$/.test(integerPart) || !/^\d*$/.test(fractionalPart)) {
    return null;
  }

  const firstTwo = fractionalPart.slice(0, 2).padEnd(2, "0");
  const cents = Number(integerPart) * 100 + Number(firstTwo);

  // Round half up on the first dropped fractional digit.
  const nextDigit = fractionalPart[2];
  const rounded = nextDigit !== undefined && Number(nextDigit) >= 5
    ? cents + 1
    : cents;

  const signed = negative ? -rounded : rounded;
  if (!Number.isInteger(signed) || Math.abs(signed) > MAX_ABSOLUTE_CENTS) {
    return null;
  }
  return signed;
}

/**
 * Formats integer cents as a two-decimal string (`2999 -> "29.00"`… actually
 * `2999 -> "29.99"`). The sign is kept explicit for negative amounts.
 */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error("formatCents requires an integer minor-unit amount.");
  }
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  return `${sign}${whole}.${fraction.toString().padStart(2, "0")}`;
}

/**
 * Integer division that rounds half up (`7 / 2 -> 4`). Used wherever a money
 * computation must settle to a single minor unit.
 */
function divideRoundHalfUp(numerator: number, divisor: number): number {
  return Math.floor((2 * numerator + divisor) / (2 * divisor));
}

/**
 * Computes `basis * basisPoints / 10000` in minor units, rounding half up —
 * basis points are 1/100 of a percent, so `percentOfCents(2999, 1325)` is
 * 13.25% of $29.99.
 */
export function percentOfCents(cents: number, basisPoints: number): number {
  return divideRoundHalfUp(cents * basisPoints, 10_000);
}

/**
 * Computes a percentage with two decimals of precision, returned in
 * "percent cents" (1/100 of one percent) so it formats with `formatCents`.
 * `percentRatioCents(1000, 4000)` -> 2500 (= 25.00%).
 *
 * A zero or negative basis is not a valid ratio: it returns `null` rather than
 * a fabricated `0%` or a division by zero.
 */
export function percentRatioCents(
  numerator: number,
  basis: number,
): number | null {
  if (basis <= 0) return null;
  return divideRoundHalfUp(
    numerator * BASIS_POINTS_PER_PERCENT * BASIS_POINTS_PER_PERCENT,
    basis,
  );
}

/** Sums a list of minor-unit amounts, ignoring nulls. */
export function sumCents(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
