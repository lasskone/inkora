# Inkora — API Integration Strategy

> **Status: Authoritative strategy.** No integration code is implemented yet.

## 1. General integration rules (all adapters)

- Use **official** APIs whenever practical. Never scrape where an API exists.
- Never fabricate a metric the API does not return.
- Every persisted value carries a **provenance** class (OFFICIAL / OBSERVED /
  ESTIMATED) — see `docs/ARCHITECTURE.md` §7.
- Every record carries a **freshness / `last_updated`** timestamp.
- Fail loudly and safely: a missing field is stored as null, never guessed.

### Cross-cutting concerns every adapter must handle

| Concern | Requirement |
| --- | --- |
| **Pagination** | Cursor/offset per the API spec; no silent truncation of result sets. |
| **Rate limits** | Respect published limits; surface remaining/quota where returned. |
| **Caching** | Cache idempotent reads with an explicit TTL and freshness timestamp. |
| **Retries / backoff** | Exponential backoff with jitter for transient errors; no retry storms. |
| **Timeouts** | Explicit per-request timeouts; never hang indefinitely. |
| **Token refresh** | Automatic refresh before expiry; refresh failures surface cleanly. |
| **Failure handling** | Distinguish 4xx (do not blindly retry) from 5xx (retryable). |
| **Stale data** | Serve stale data only when clearly marked as stale. |
| **Observability** | Structured logs without secrets; per-request duration and status. |

**Logging rule:** secrets, tokens, and credentials are never logged.

## 2. eBay

Use official eBay APIs whenever practical.

### Expected functional areas

- product / listing discovery (search APIs)
- seller information where available
- prices
- categories
- item identifiers
- images
- location
- shipping information
- condition
- attributes
- authenticated functionality when required

### Hard constraint on sales data

Do **not** assume exact competitor sales numbers are available from official
APIs. Where a sales figure is needed and not returned officially:

- mark an observed signal as **OBSERVED**, or
- model an estimate as **ESTIMATED**, recording its method and inputs.

**Never fabricate an unavailable metric.**

### Authentication / token handling (conceptual)

- OAuth2 **client-credentials** grant for application access where sufficient.
- **Authorization-code** grant with `connected_accounts` storage when
  user-scoped access is required.
- Tokens and secrets live **server-side / encrypted at rest only**.
- Client IDs and secrets are read from environment variables (see
  `.env.example`) — never hardcoded, never shipped to the frontend.
- Token refresh is automatic and logged **without secret values**.

### Environments

- Sandbox and production have distinct base URLs and token endpoints.
- The active environment is selected by **configuration**, never by editing
  code.

## 3. CJdropshipping

Use CJ's official API.

### Expected functional areas

- product search
- categories
- product details
- variants
- SKU / VID
- inventory
- pricing
- logistics
- shipping quotes where supported
- warehouse / location information where supported

### Strategic note: US warehouses

**US warehouse availability is especially important for the initial eBay
strategy** — delivery time to US buyers, shipping cost predictability, and
marketplace trust signals. Inventory lookups should prefer and flag
US-warehoused stock where the API supports it.

### Authentication / token handling (conceptual)

- CJ credentials are read from **environment variables only**.
- The access token is obtained server-side, cached with its expiry, and
  refreshed automatically.
- Credentials are never exposed to the frontend and never logged.

## 4. The sourcing pipeline (eBay → CJ)

```text
eBay opportunity
  → Product Matcher
  → CJ candidates
  → US inventory when available
  → supplier cost
  → shipping
  → landed cost
  → eBay fees
  → estimated profit
  → margin
  → Opportunity Score
```

Each step is deterministic where it touches money, and each emitted value is
provenance-tagged.

## 5. Supplier policy

Inkora prioritizes supplier/fulfillment ecosystems that can be accessed and
integrated **without requiring users to purchase recurring supplier
subscriptions** merely to source, import, or fulfill products.

**Initial ecosystem:** CJdropshipping — **AliExpress later.**

**Explicitly excluded from the roadmap:**

- Zendrop
- Spocket
- other paid supplier platforms, *unless* a future review determines their
  relevant sourcing/integration model is genuinely free and strategically
  useful.

The software may remain extensible through a generic **Supplier Adapter**
architecture. **Extensibility must not be interpreted as planned support for
paid suppliers.** No placeholder adapters, code, or configuration for excluded
platforms.

## 6. What is not implemented in this task

- No eBay API calls.
- No CJ API calls.
- No token acquisition, storage, or refresh code.
- No adapter implementations of any kind.

These arrive in later, individually reviewed stages (see `docs/ROADMAP.md`).
