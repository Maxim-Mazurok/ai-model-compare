import type { AaIntelligenceIndexCost, CostMode, ModelVariant, ScoredVariant, TaskProfile } from "./types";

export const DEFAULT_METRIC = "artificial_analysis_intelligence_index";

export const metricLabels: Record<string, string> = {
  artificial_analysis_intelligence_index: "Intelligence",
  artificial_analysis_coding_index: "Coding",
  artificial_analysis_math_index: "Math",
  artificial_analysis_agentic_index: "Agentic",
  terminalbench_hard: "Terminal-Bench Hard",
  livecodebench: "LiveCodeBench",
  scicode: "SciCode",
  gpqa: "GPQA",
  hle: "HLE",
  ifbench: "IFBench",
  tau2: "Tau2"
};

export function labelForMetric(metric: string) {
  return (
    metricLabels[metric] ??
    metric
      .replace(/^artificial_analysis_/, "")
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function blendedCost(variant: ModelVariant, profile: TaskProfile) {
  const input = variant.pricing.input;
  const cached = variant.pricing.cachedInput;
  const output = variant.pricing.output;
  if (input === null || cached === null || output === null) return null;

  const cost =
    profile.tokenBlend.cachedInput * cached +
    profile.tokenBlend.freshInput * input +
    profile.tokenBlend.output * output;

  return Number(cost.toFixed(6));
}

function roundedCost(value: number) {
  return Number(value.toFixed(6));
}

export function taskCostBreakdown(variant: ModelVariant): AaIntelligenceIndexCost | null {
  const counts = variant.model?.intelligenceIndexTokenCounts;
  const inputPrice = variant.pricing.input;
  const outputPrice = variant.pricing.output;

  if (
    counts &&
    inputPrice !== null &&
    inputPrice !== undefined &&
    outputPrice !== null &&
    outputPrice !== undefined &&
    Number.isFinite(inputPrice) &&
    Number.isFinite(outputPrice)
  ) {
    const inputTokens = counts.input ?? 0;
    const answerTokens = counts.answer ?? 0;
    const reasoningTokens = counts.reasoning ?? 0;
    const outputTokens = counts.output ?? answerTokens + reasoningTokens;
    const input = (inputTokens / 1_000_000) * inputPrice;
    const output = (outputTokens / 1_000_000) * outputPrice;
    const answer = (answerTokens / 1_000_000) * outputPrice;
    const reasoning = (reasoningTokens / 1_000_000) * outputPrice;
    const total = input + output;

    if (total > 0) {
      return {
        total: roundedCost(total),
        input: roundedCost(input),
        output: roundedCost(output),
        reasoning: roundedCost(reasoning),
        answer: roundedCost(answer)
      };
    }
  }

  const aaCost = variant.model?.intelligenceIndexCost;
  if (!aaCost) return null;
  const total = aaCost?.total;
  if (total === null || total === undefined || !Number.isFinite(total) || total <= 0) return null;
  return {
    total: roundedCost(total),
    input: aaCost.input === null || aaCost.input === undefined ? null : roundedCost(aaCost.input),
    output: aaCost.output === null || aaCost.output === undefined ? null : roundedCost(aaCost.output),
    reasoning: aaCost.reasoning === null || aaCost.reasoning === undefined ? null : roundedCost(aaCost.reasoning),
    answer: aaCost.answer === null || aaCost.answer === undefined ? null : roundedCost(aaCost.answer)
  };
}

export function taskCost(variant: ModelVariant) {
  return taskCostBreakdown(variant)?.total ?? null;
}

function intelligenceIndexOutputTokens(variant: ModelVariant) {
  const counts = variant.model?.intelligenceIndexTokenCounts;
  if (!counts) return null;
  const outputTokens = counts.output ?? (counts.answer ?? 0) + (counts.reasoning ?? 0);
  return outputTokens > 0 && Number.isFinite(outputTokens) ? outputTokens : null;
}

export function taskCompletionSeconds(variant: ModelVariant) {
  const outputTokens = intelligenceIndexOutputTokens(variant);
  const outputTokensPerSecond = variant.effectivePerformance.outputTokensPerSecond;
  if (
    outputTokens === null ||
    outputTokensPerSecond === null ||
    outputTokensPerSecond === undefined ||
    !Number.isFinite(outputTokensPerSecond) ||
    outputTokensPerSecond <= 0
  ) {
    return null;
  }

  return Number((outputTokens / outputTokensPerSecond).toFixed(3));
}

export function comparisonSpeedValue(variant: ModelVariant, costMode: CostMode) {
  if (costMode === "task") return taskCompletionSeconds(variant);
  const speed = variant.effectivePerformance.outputTokensPerSecond;
  return speed !== null && speed !== undefined && Number.isFinite(speed) && speed > 0 ? speed : null;
}

export function comparisonCost(variant: ModelVariant, profile: TaskProfile, costMode: CostMode) {
  const tokenCost = blendedCost(variant, profile);
  if (costMode === "token") {
    return {
      cost: tokenCost,
      source: "token" as const,
      blendedCost: tokenCost
    };
  }

  const aaTaskCost = taskCost(variant);
  return {
    cost: aaTaskCost,
    source: "task" as const,
    blendedCost: tokenCost
  };
}

export function scoreVariants(
  variants: ModelVariant[],
  profile: TaskProfile,
  metric: string,
  costMode: CostMode = "token"
): ScoredVariant[] {
  return variants.map((variant) => {
    const raw = variant.model?.evaluations?.[metric];
    const metricValue = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const { cost, source, blendedCost } = comparisonCost(variant, profile, costMode);
    const taskCost = taskCostBreakdown(variant);
    const taskTime = taskCompletionSeconds(variant);
    const valueScore =
      metricValue === null || cost === null || cost <= 0
        ? null
        : Number((metricValue / cost).toFixed(3));

    return {
      ...variant,
      metricValue,
      blendedCost,
      taskCost,
      taskCompletionSeconds: taskTime,
      comparisonCost: cost,
      comparisonCostSource: source,
      comparisonSpeedValue: costMode === "task" ? taskTime : comparisonSpeedValue(variant, costMode),
      valueScore
    };
  });
}

export function paretoFrontier(points: ScoredVariant[]) {
  const usable = points
    .filter((point) => point.metricValue !== null && point.comparisonCost !== null && point.comparisonCost > 0)
    .sort((a, b) =>
      a.comparisonCost! === b.comparisonCost!
        ? b.metricValue! - a.metricValue!
        : a.comparisonCost! - b.comparisonCost!
    );

  const frontier: ScoredVariant[] = [];
  let bestScore = -Infinity;
  for (const point of usable) {
    if (point.metricValue! > bestScore) {
      frontier.push(point);
      bestScore = point.metricValue!;
    }
  }
  return frontier;
}

export function formatPrice(value: number | null | undefined, unit = "usd_per_1m_tokens") {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  if (value < 10) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(1)}`;
}

export function valueUnitLabel(unit = "usd_per_1m_tokens") {
  return unit === "credits_per_1m_tokens" ? "credit/M" : "$/M";
}

export function formatNumber(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString(undefined, {
    maximumFractionDigits: digits
  });
}
