/**
 * The deterministic Opportunity Engine V1 entry point.
 *
 * `assessOpportunity` takes one fully-populated `OpportunityInput` and returns a
 * complete, self-explaining `OpportunityAssessment`. It is the only function the
 * route ever calls, and it is pure: no provider, no database, no clock
 * (docs/ARCHITECTURE.md §9).
 *
 * Because every input is either a normalized value or an explicit `null`, an
 * assessment is **reproducible from the input object alone** — which is also how
 * the unit tests pin the model, and how a persisted assessment stays auditable
 * after the engine moves to a new version.
 */

import type {
  AppliedCap,
  ComponentName,
  OpportunityAssessment,
  OpportunityFactor,
  OpportunityInput,
} from "./types";
import {
  COMPONENT_WEIGHTS,
  OPPORTUNITY_ENGINE_VERSION,
  SCALE_MAX,
  bandForScore,
} from "./types";
import { assessCompetition } from "./competition";
import { assessDataQuality } from "./data-quality";
import { assessDemand, demandVerdictLabel } from "./demand";
import {
  assessEconomicsComponent,
  assessMatchComponent,
  aggregateScore,
  componentContributions,
  computeConfidence,
  evaluateGates,
} from "./score";
import type { ComponentScores } from "./score";

/** Human-readable component names, in the order the explanation presents them. */
const COMPONENT_LABELS: Record<ComponentName, string> = {
  economics: "Economics",
  match: "Product match",
  competition: "Competition",
  demand: "Demand evidence",
  dataQuality: "Data quality",
};

/**
 * The one entry point. Never throws: every degenerate input — no candidate, no
 * economics, no history, no competition window — is a legitimate, fully
 * explainable state that produces a complete assessment.
 */
export function assessOpportunity(input: OpportunityInput): OpportunityAssessment {
  const economics = assessEconomicsComponent(input);
  const match = assessMatchComponent(input);
  const competition = assessCompetition(input);
  const demand = assessDemand(input);
  const dataQuality = assessDataQuality(input);

  const components: ComponentScores = {
    economics: economics.score,
    match: match.score,
    competition: competition.score,
    demand: demand.score,
    dataQuality: dataQuality.score,
  };

  const rawScore = aggregateScore(components);
  const caps = evaluateGates(input);
  const effectiveCap = caps.reduce<number>(
    (minimum, cap) => Math.min(minimum, cap.cap),
    SCALE_MAX,
  );
  const score = Math.min(rawScore, effectiveCap);
  const band = bandForScore(score);

  const confidence = computeConfidence({
    economicsCompleteness: economics.completeness,
    matchConfidence: match.confidence,
    dataQuality,
    demandVerdict: demand.verdict,
  });

  const factors = buildFactors(components, rawScore, score, caps);
  const explanation = buildExplanation({
    input,
    economics,
    match,
    competition,
    demand,
    dataQuality,
    rawScore,
    score,
    caps,
    confidence,
  });

  return {
    engineVersion: OPPORTUNITY_ENGINE_VERSION,
    calculatedAt: input.now,
    marketplace: input.marketplaceProduct.marketplace,
    marketplaceExternalId: input.marketplaceProduct.externalId,
    supplier: input.candidate?.supplierProduct.supplier ?? "cj",
    supplierExternalId: match.supplierExternalId || (input.candidate?.supplierProduct.externalId ?? ""),
    score,
    band,
    confidence: confidence.confidence,
    confidenceLevel: confidence.level,
    components: { economics, match, competition, demand, dataQuality },
    factors,
    caps,
    headline: buildHeadline({ band, score, economics, match, confidence }),
    explanation,
    caveats: buildCaveats({ economics, match, competition, demand }),
    inputs: {
      marketplaceSnapshotObservedAt: input.marketplaceProduct.fetchedAt,
      supplierSnapshotObservedAt: input.candidate?.supplierProduct.fetchedAt ?? null,
      economicsCalculatedAt: input.economics?.calculatedAt ?? null,
      competitionQuery: input.competition?.query ?? null,
      historyAvailable: input.history !== null,
    },
  };
}

/**
 * Builds the factor list: one per component, in the order they aggregate, plus
 * a single reconciling factor for the caps. The factors always sum exactly to
 * the reported score, so the explanation can be checked by hand.
 */
function buildFactors(
  components: ComponentScores,
  rawScore: number,
  score: number,
  caps: AppliedCap[],
): OpportunityFactor[] {
  const factors: OpportunityFactor[] = componentContributions(components).map(
    (contribution) => ({
      name: `${contribution.name}Component`,
      label: COMPONENT_LABELS[contribution.name],
      contribution: contribution.contribution,
      detail: `${COMPONENT_LABELS[contribution.name]} contributed ` +
        `${contribution.contribution} of the ${rawScore}-point raw score ` +
        `(component ${components[contribution.name]}/100).`,
    }),
  );

  if (score < rawScore) {
    factors.push({
      name: "appliedCaps",
      label: "Conservative gates",
      contribution: score - rawScore,
      detail:
        caps.length === 1
          ? `One conservative gate limited the score from ${rawScore} to ${score}: ${caps[0].label}.`
          : `${caps.length} conservative gates limited the score from ${rawScore} to ${score}: ` +
            caps.map((cap) => cap.label).join(", ") +
            ".",
    });
  }

  return factors;
}

/** One deterministic headline sentence, for list views and notifications. */
function buildHeadline({
  band,
  score,
  economics,
  match,
  confidence,
}: {
  band: OpportunityAssessment["band"];
  score: number;
  economics: ReturnType<typeof assessEconomicsComponent>;
  match: ReturnType<typeof assessMatchComponent>;
  confidence: ReturnType<typeof computeConfidence>;
}): string {
  const economicsPhrase =
    economics.estimatedProfit === null
      ? "no profit figure could be computed"
      : `estimated profit is ${economics.estimatedProfit}`;
  const matchPhrase =
    match.confidence === 0
      ? "no supplier candidate was found"
      : `match confidence is ${match.confidence}/100`;
  return (
    `${score}/100 ${band} — ${economicsPhrase}, ${matchPhrase}, ` +
    `evidence confidence ${confidence.confidence}/100.`
  );
}

/** Ordered, human-readable explanation. The UI renders these lines as-is. */
function buildExplanation({
  input,
  economics,
  match,
  competition,
  demand,
  dataQuality,
  rawScore,
  score,
  caps,
  confidence,
}: {
  input: OpportunityInput;
  economics: ReturnType<typeof assessEconomicsComponent>;
  match: ReturnType<typeof assessMatchComponent>;
  competition: ReturnType<typeof assessCompetition>;
  demand: ReturnType<typeof assessDemand>;
  dataQuality: ReturnType<typeof assessDataQuality>;
  rawScore: number;
  score: number;
  caps: AppliedCap[];
  confidence: ReturnType<typeof computeConfidence>;
}): string[] {
  const lines: string[] = [];

  lines.push(
    `Assessment of the ${input.marketplaceProduct.marketplace} listing ` +
      `${input.marketplaceProduct.externalId} under Opportunity Engine ` +
      `${OPPORTUNITY_ENGINE_VERSION}.`,
  );

  lines.push(
    match.confidence === 0
      ? `Product match: no supplier candidate was found, so product identity is unknown.`
      : `Product match: ${match.explanation}`,
  );

  lines.push(`Economics: ${economics.rationale}`);

  lines.push(
    competition.verdict === "INSUFFICIENT_EVIDENCE"
      ? `Competition: insufficient evidence — no competition figure was estimated.`
      : `Competition: appears ${competitionVerdictPhrase(competition.verdict)} ` +
        `(intensity ${competition.intensity}/100 from ${competition.sampleSize} inspected ` +
        `listing${competition.sampleSize === 1 ? "" : "s"} and ` +
        `${competition.distinctSellers} distinct seller${competition.distinctSellers === 1 ? "" : "s"} ` +
        `for the query “${competition.query}”).`,
  );

  lines.push(`Demand evidence: ${demandVerdictLabel(demand.verdict)}.`);
  if (demand.evidence.length > 0) lines.push(demand.evidence[0]);

  lines.push(
    `Data quality: ${dataQuality.score}/100 across ${dataQuality.dimensions.length} checked dimensions.`,
  );

  lines.push(
    `Raw score: the five components contributed ${rawScore} points ` +
      `(weights — economics ${COMPONENT_WEIGHTS.economics}, match ${COMPONENT_WEIGHTS.match}, ` +
      `competition ${COMPONENT_WEIGHTS.competition}, demand ${COMPONENT_WEIGHTS.demand}, ` +
      `data quality ${COMPONENT_WEIGHTS.dataQuality}).`,
  );

  for (const cap of caps) {
    lines.push(`Gate applied — ${cap.label}: ${cap.reason}`);
  }

  lines.push(
    score === rawScore
      ? `Final score: ${score}/100 (${bandForScore(score)} band); no gate limited it.`
      : `Final score: ${score}/100 (${bandForScore(score)} band), limited from the raw ` +
        `${rawScore} by ${caps.length === 1 ? "one conservative gate" : `${caps.length} conservative gates`}.`,
  );

  lines.push(
    `Evidence confidence: ${confidence.confidence}/100 (${confidence.level}). ` +
      `The weighted evidence blend was ${confidence.weightedBlend}, limited to ` +
      `${confidence.slackLimited} by the weakest hard evidence dimension ` +
      `(${confidence.weakestEvidence}), then multiplied by the demand factor ` +
      `${confidence.demandFactor}.`,
  );

  return lines;
}

/** Lowercase phrase for a competition verdict, for use in prose. */
function competitionVerdictPhrase(
  verdict: ReturnType<typeof assessCompetition>["verdict"],
): string {
  switch (verdict) {
    case "APPEARS_LIMITED":
      return "limited";
    case "APPEARS_MODERATE":
      return "moderate";
    case "APPEARS_BROAD":
      return "broad";
    default:
      return "unknown";
  }
}

/** What this assessment does NOT mean. Always rendered alongside the score. */
function buildCaveats({
  economics,
  match,
  competition,
  demand,
}: {
  economics: ReturnType<typeof assessEconomicsComponent>;
  match: ReturnType<typeof assessMatchComponent>;
  competition: ReturnType<typeof assessCompetition>;
  demand: ReturnType<typeof assessDemand>;
}): string[] {
  const caveats = [
    "This is a deterministic assessment of evidence, not a prediction of sales or profit.",
    "Marketplace fees are Inkora's rule-based estimate over published eBay policy, not an exact eBay charge.",
  ];

  if (economics.supplierCostBasis !== "SELECTED_VARIANT") {
    caveats.push(
      economics.supplierCostBasis === null
        ? "No supplier cost basis was recorded, so the money figures may not describe a specific variant."
        : "Supplier cost is a reference value, not the definitive cost of a resolved variant, so the profit figure is a reference too.",
    );
  }
  if (match.cappedByHardContradiction) {
    caveats.push(
      "The matcher found hard evidence against this match, so these figures may describe a different product.",
    );
  }
  if (competition.verdict !== "INSUFFICIENT_EVIDENCE") {
    caveats.push(...competition.caveats);
  }
  caveats.push(...demand.limitations);
  if (economics.warnings.length > 0) caveats.push(...economics.warnings);

  return caveats;
}

