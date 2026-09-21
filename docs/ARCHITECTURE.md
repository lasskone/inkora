# Inkora — Architecture

> **Status: Authoritative (concept level).** This document defines architecture
> principles and conceptual responsibilities. It deliberately does **not** fix a
> framework choice or a full production schema — those come later, one reviewed
> increment at a time.

## 1. Guiding principles

1. **Separate acquisition from intelligence.** Code that talks to a marketplace
   or supplier knows nothing about opportunity scoring. Code that scores
   opportunities knows nothing about HTTP/token specifics.
2. **Normalize, then reason.** External data is converted into Inkora's
   internal model exactly once; all downstream logic operates on normalized
   entities.
3. **Deterministic economics.** Money math is code, never LLM-generated.
4. **Provenance is a first-class citizen.** Every quantitative value knows
   whether it is OFFICIAL, OBSERVED, or ESTIMATED.
5. **History is an asset.** The platform must not depend solely on live API
   responses.
6. **Do not over-engineer what is not yet required.** Interfaces are documented
   conceptually; build only the adapter currently needed.

## 2. Technology stack

The application stack was resolved in the application-foundation task, using the
official Next.js scaffolding toolchain. It is deliberately conservative and
production-oriented.

| Concern | Choice |
| --- | --- |
| Web framework | **Next.js** (App Router) |
| Language | **TypeScript** |
| Styling | **Tailwind CSS** |
| Package manager | **npm** |
| Linting | **ESLint** (flat config, `eslint-config-next`) |
| Database / backend | **Supabase (PostgreSQL)** |
| Source control | GitHub |
| Domain | inkora.net |
| Runtime | Node.js |

### 2.1 Server / client boundary

- **Server Components by default.** A `"use client"` directive is added only
  where browser interactivity genuinely requires it (for example navigation
  state derived from the current route).
- **Sensitive integrations belong on the server.** eBay secrets, CJ credentials,
  AI API keys, and Supabase service-role operations must never be bundled into
  client-side JavaScript.
- Server-only modules import the `server-only` package, so any attempt to pull
  them into a Client Component fails at build time.
- Credentials are read from environment variables only; variables holding
  private credentials never use the `NEXT_PUBLIC_` prefix
  (see `.env.example`).

### 2.2 Verified Supabase connectivity

Inkora's Next.js server reaches Supabase through **one** privileged server-side
boundary, and this connectivity has been verified end-to-end against the live
project — not merely inferred from environment variables or client
construction.

```text
Next.js server process
  → src/lib/supabase/server.ts   (import "server-only", service-role key)
  → live Supabase project (PostgreSQL)
```

Verified facts:

- The browser client (`src/lib/supabase/client.ts`) uses **only**
  `NEXT_PUBLIC_*` values (project URL + anon key). It never sees the
  service-role key or `SUPABASE_DB_URL`.
- The server client uses the **service-role key**, read from a non-prefixed
  variable inside a `server-only` module, so it cannot leak into a client
  bundle.
- `GET /api/health/db` performs a real, benign, read-only round-trip to the
  live project and reports only a coarse verdict
  (`reachable` / `unreachable`).
- `GET /api/health` (application process health) is **independent of Supabase**.
  A database outage degrades `/api/health/db` but must never make
  `/api/health` fail.

### 2.3 Health endpoints — separation of concerns

| Endpoint | Answers | Depends on Supabase? |
| --- | --- | --- |
| `GET /api/health` | Is the Inkora application process healthy? | **No** |
| `GET /api/health/db` | Can the Inkora server reach its Supabase database? | **Yes** |

Both responses are sanitized: no raw errors, hostnames, ports, connection
strings, SQL, credentials, or stack traces are ever returned.

### 2.4 Migration ownership

**GitHub is the source of truth for schema.** Migration files live in
`supabase/migrations/`, are committed and reviewed like any other code, and are
applied to the remote database in order. The remote database is never hand-edited
into a state that the committed migrations cannot reproduce. See
`docs/DATABASE.md`.

## 3. The core pipeline

```text
Marketplace data
  → normalized product intelligence
  → supplier matching
  → economics
  → opportunity scoring
```

Every stage is observable, testable, and replayable. Raw inputs are retained so
any downstream number can be re-derived later.

## 4. Marketplace integrations — `MarketplaceAdapter`

**Conceptual interface.** A marketplace adapter is responsible *only* for:

- authenticating to the marketplace,
- fetching raw listing/product/seller data,
- normalizing that data into Inkora's internal marketplace model,
- honoring pagination, rate limits, retries, and freshness rules,
- attaching **provenance** and a `last_updated` timestamp to everything it
  emits.

**Initial implementation target:** `EbayAdapter`.

Possible future adapters — documented for extensibility only, **do not
implement now**:

- `AmazonAdapter`
- `EtsyAdapter`
- `TikTokAdapter`

Marketplace-specific logic must never leak into core domain services.

## 5. Supplier integrations — `SupplierAdapter`

**Conceptual interface.** A supplier adapter is responsible *only* for:

- authenticating to the supplier,
- searching supplier products,
- returning variants, SKU/VID, inventory, pricing, logistics, and shipping
  quotes where supported,
- normalizing into Inkora's internal supplier model,
- attaching **provenance** and freshness.

**Initial implementation target:** `CJAdapter`.

Later possible adapter: `AliExpressAdapter`.

Explicitly **not** to be created:

- `ZendropAdapter`
- `SpocketAdapter`

See the supplier policy in `docs/API_INTEGRATIONS.md`.

## 6. Core domain services (conceptual responsibilities)

### 6.1 Product Matcher

See §8. Matches marketplace products to supplier products and returns a
**confidence level**.

### 6.2 Fee Engine

Deterministic. Given a marketplace, a category, a price, and a payment method,
it returns the applicable marketplace and payment fees. Fee assumptions are
data-driven, transparent, and versionable (the `fee_rules` entity). No LLM
arithmetic — see §9 and `docs/DATABASE.md`.

### 6.3 Profit Engine

Deterministic. Composes:

```text
Selling Price
  − Marketplace Fees
  − Payment Fees (when applicable)
  − Supplier Cost
  − Shipping Cost
  − other explicitly modeled costs
  = Estimated Net Profit
```

Margin is derived deterministically from the same inputs. Both profit and
margin are labeled **ESTIMATED**.

### 6.4 Opportunity Engine

Deterministic and versionable scoring. Consumes raw metrics, applies a declared
weighting model, and emits an **Opportunity Score** plus a human/AI-readable
explanation. See §9.

### 6.5 Snapshot / Historical Data Layer

Captures time-stamped observations (price, stock, competition, seller, score)
so trends are *measured*, not guessed. Raw metrics are retained independently
of final scores. See `docs/DATABASE.md`.

### 6.6 Watchlist Monitoring

Periodically re-evaluates watched items and reports meaningful change (price,
stock, score, competition) without re-scanning the entire marketplace.

### 6.7 Provenance Layer

Cross-cutting. Tags every value OFFICIAL / OBSERVED / ESTIMATED and propagates
that tag from storage through to the UI. See §7.

## 7. Data provenance

Three explicit, non-negotiable categories:

| Category | Meaning |
| --- | --- |
| **OFFICIAL** | Returned directly from an official API or authenticated first-party integration. |
| **OBSERVED** | Legitimately observable marketplace/source data, not necessarily returned by the primary official API. |
| **ESTIMATED** | Values calculated or modeled by Inkora. |

Rules:

- Never fabricate precision.
- Never present an estimated value as an official value.
- The UI must make provenance visible wherever it affects a decision.
- Provenance is stored at the column level where practical
  (see `docs/DATABASE.md`).

Worked example:

| Value | Provenance |
| --- | --- |
| eBay listing price | **OFFICIAL** |
| Observed sales signal | **OBSERVED** |
| Estimated monthly sales | **ESTIMATED** |
| CJ inventory quantity | **OFFICIAL** (when returned by the CJ API) |
| Estimated net profit | **ESTIMATED** (calculated) |

## 8. Product Matcher (foundational component)

The same physical product carries different titles on a marketplace and in a
supplier catalogue. Matching is therefore a first-class, confidence-bearing
component — not an afterthought.

Candidate matching signals (to be validated; not all implemented at once):

- normalized title similarity
- semantic similarity
- image similarity
- attributes, dimensions, color
- variant structure
- brand / model
- UPC, EAN, GTIN
- marketplace identifiers
- supplier SKU characteristics

Rules:

- Every match returns a **confidence level**.
- Uncertain matches **remain uncertain**; they are never silently promoted to
  exact.
- Fuzzy/semantic matches must never be presented as exact matches.

## 9. Opportunity Engine (conceptual)

The **Opportunity Score** is:

- **deterministic** — same inputs + same weighting version ⇒ same score;
- **versionable** — the weighting model has a version that is stored alongside
  the score;
- **explainable** — AI may *explain* a score; AI must **not** invent the
  numerical score.

Candidate input signals:

- demand, competition, estimated profit, margin, sales velocity,
  seller saturation, supplier availability, stock, shipping speed/cost,
  price stability, trend.

Raw metrics are stored independently of the final score (see
`docs/DATABASE.md`) so a score can be recomputed when the weighting model
changes.

The architecture must **not** permanently hard-code an arbitrary weighting
model. A preliminary model may be documented **as an example only**, clearly
labeled provisional.

## 10. Online-first development

Inkora validates integration reality early and progressively: build health,
deployment behavior, Supabase connectivity, environment configuration, eBay
connectivity, CJ connectivity, and production-like failure modes.

We do not postpone real integration validation until the end of the project —
but we also do not deploy unfinished feature code just to satisfy this
principle. See `docs/ROADMAP.md`.

## 11. What this document intentionally does not decide

- The concrete internal design of the adapters (they will be server-side on the
  platform fixed in §2, but their detailed design arrives with their own
  implementation task).
- The final weighting model for the Opportunity Score.
- The production schema (see `docs/DATABASE.md`, which separates likely MVP
  tables from future and unvalidated entities).