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

**No application framework has been chosen yet.** That is intentional — the
stack decision belongs to the Lead Architect after this foundation is reviewed.

Confirmed infrastructure:

| Concern | Choice |
| --- | --- |
| Database / backend | Supabase (PostgreSQL) |
| Source control | GitHub |
| Domain | inkora.net |
| Runtime available in dev | Node.js |

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

- The web/UI framework or adapter implementation language.
- The final weighting model for the Opportunity Score.
- The production schema (see `docs/DATABASE.md`, which separates likely MVP
  tables from future and unvalidated entities).