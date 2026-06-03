import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  CircleAlert,
  CircleDollarSign,
  Filter,
  Gauge,
  GitCompareArrows,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Target,
  Upload,
  X,
  Zap
} from "lucide-react";
import type {
  CostMode,
  ModelVariant,
  ModelsPayload,
  ProviderOverlay,
  ProviderOverlayModel,
  ScoredVariant,
  TaskProfile
} from "./types";
import {
  DEFAULT_METRIC,
  formatNumber,
  formatPrice,
  labelForMetric,
  paretoFrontier,
  scoreVariants,
  valueUnitLabel
} from "./modelMath";
import { ScatterPlot, type XAxisMode } from "./ScatterPlot";

const preferredMetrics = [
  "artificial_analysis_intelligence_index",
  "artificial_analysis_coding_index",
  "artificial_analysis_agentic_index",
  "terminalbench_hard",
  "livecodebench",
  "scicode",
  "gpqa"
];

const xAxisModeOptions: { mode: XAxisMode; label: string }[] = [
  { mode: "log", label: "Log-like" },
  { mode: "linear", label: "Linear" }
];

const costModeOptions: { mode: CostMode; label: string }[] = [
  { mode: "task", label: "Task cost" },
  { mode: "token", label: "Token cost" }
];

const OVERLAY_STORAGE_KEY = "model-routes.provider-overlays.v1";
const RANGE_EPSILON = 0.0000001;
const rangeFilterKeys = ["score", "price", "speed"] as const;

type RangeFilterKey = (typeof rangeFilterKeys)[number];
type NumericRange = {
  min: number;
  max: number;
};
type NumericDomain = NumericRange & {
  inputStep: number;
  decimals: number;
};
type RangeFilters = Record<RangeFilterKey, NumericRange>;
type RangeDomains = Record<RangeFilterKey, NumericDomain>;

function useModels() {
  const [payload, setPayload] = useState<ModelsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(refresh = false) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}data/models.json`, {
        cache: refresh ? "reload" : "default"
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Failed to load model data");
      setPayload(json);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return { payload, loading, error, reload: () => load(true) };
}

const providerPalette: Record<string, string> = {
  "Azure AI Foundry": "#2f67b1",
  Codex: "#d14b1f",
  "Direct API": "#8a6b12",
  "GitHub Copilot": "#6f42c1",
  "LLM Gateway": "#b94626",
  OpenRouter: "#c04472"
};

function providerColor(provider: string) {
  if (providerPalette[provider]) return providerPalette[provider];
  const palette = [
    "#1f7a68",
    "#b94626",
    "#2f67b1",
    "#8a6b12",
    "#c04472",
    "#507b2d",
    "#7a4a21",
    "#3f6d75"
  ];
  let hash = 0;
  for (const char of provider) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function decimalPlaces(value: number) {
  const [, decimals = ""] = value.toString().split(".");
  return decimals.length;
}

function roundToDecimals(value: number, decimals: number) {
  return Number(value.toFixed(decimals));
}

function ceilToStep(value: number, step: number) {
  return roundToDecimals(Math.ceil(value / step) * step, decimalPlaces(step) + 2);
}

function floorToStep(value: number, step: number) {
  return roundToDecimals(Math.floor(value / step) * step, decimalPlaces(step) + 2);
}

function formatEditableNumber(value: number, decimals: number) {
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

function finiteValues(values: Array<number | null | undefined>) {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function domainFromValues(
  values: Array<number | null | undefined>,
  {
    fallbackMax,
    inputStep,
    decimals,
    startAtZero = true
  }: {
    fallbackMax: number;
    inputStep: number;
    decimals: number;
    startAtZero?: boolean;
  }
): NumericDomain {
  const finite = finiteValues(values);
  const rawMin = finite.length ? Math.min(...finite) : 0;
  const rawMax = finite.length ? Math.max(...finite) : fallbackMax;
  const min = startAtZero ? 0 : floorToStep(rawMin, inputStep);
  const max = ceilToStep(rawMax, inputStep);
  const safeMax = max <= min ? roundToDecimals(min + inputStep, decimals) : max;

  return {
    min: roundToDecimals(min, decimals),
    max: roundToDecimals(safeMax, decimals),
    inputStep,
    decimals
  };
}

function rangesFromDomains(domains: RangeDomains): RangeFilters {
  return {
    score: { min: domains.score.min, max: domains.score.max },
    price: { min: domains.price.min, max: domains.price.max },
    speed: { min: domains.speed.min, max: domains.speed.max }
  };
}

function rangesAreClose(first: NumericRange, second: NumericRange) {
  return Math.abs(first.min - second.min) <= RANGE_EPSILON && Math.abs(first.max - second.max) <= RANGE_EPSILON;
}

function rangeOutsideDomain(range: NumericRange, domain: NumericDomain) {
  return range.max < domain.min || range.min > domain.max;
}

function constrainRange(range: NumericRange, domain: NumericDomain, changed: "min" | "max" = "max") {
  const min = clamp(range.min, domain.min, domain.max);
  const max = clamp(range.max, domain.min, domain.max);
  if (min <= max) return { min, max };
  return changed === "min" ? { min, max: min } : { min: max, max };
}

function reconcileRange(range: NumericRange, domain: NumericDomain, previousDomain: NumericDomain | undefined) {
  const domainRange = { min: domain.min, max: domain.max };
  if (!previousDomain || rangesAreClose(range, previousDomain) || rangeOutsideDomain(range, domain)) {
    return domainRange;
  }
  return constrainRange(range, domain);
}

function reconcileRangeFilters(
  ranges: RangeFilters,
  domains: RangeDomains,
  previousDomains: RangeDomains | null
): RangeFilters {
  return {
    score: reconcileRange(ranges.score, domains.score, previousDomains?.score),
    price: reconcileRange(ranges.price, domains.price, previousDomains?.price),
    speed: reconcileRange(ranges.speed, domains.speed, previousDomains?.speed)
  };
}

function valueInRange(value: number | null | undefined, range: NumericRange) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value + RANGE_EPSILON >= range.min &&
    value - RANGE_EPSILON <= range.max
  );
}

function percentOfDomain(value: number, domain: NumericDomain) {
  const span = domain.max - domain.min;
  if (span <= 0) return 0;
  return clamp(((value - domain.min) / span) * 100, 0, 100);
}

function formatShortDate(value: string | null | undefined) {
  if (!value) return "unknown";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function sourceSummary(payload: ModelsPayload) {
  const sources = payload.routeConfig?.sources ?? [];
  if (!sources.length) return "No route source metadata";
  const ok = sources.filter((source) => source.status === "ok").length;
  const errors = sources.length - ok;
  return errors ? `${ok}/${sources.length} sources ok, ${errors} warning${errors === 1 ? "" : "s"}` : `${ok}/${sources.length} sources ok`;
}

function sourceIdsForVariant(variant: ScoredVariant) {
  if (variant.route === "github-copilot") return ["github-copilot-pricing", "github-models-catalog"];
  if (variant.route === "anthropic-api") return ["claude-pricing"];
  if (variant.route === "codex-flexible-pricing") return ["codex-rate-card", "codex-credit-value"];
  if (variant.route === "azure-foundry-global-standard") return ["azure-foundry-global-standard"];
  return [];
}

function variantFreshness(variant: ScoredVariant, payload: ModelsPayload) {
  const metadata = variant.metadata ?? {};
  const overlayFetchedAt = typeof metadata.overlayFetchedAt === "string" ? metadata.overlayFetchedAt : null;
  const priceMatchedProvider =
    typeof metadata.priceMatchedProvider === "string" ? metadata.priceMatchedProvider : "public route";
  if (metadata.importedOverlay && overlayFetchedAt) {
    return `Overlay ${formatShortDate(overlayFetchedAt)}; public price matched from ${priceMatchedProvider}`;
  }

  const sources = payload.routeConfig?.sources ?? [];
  const matched = sourceIdsForVariant(variant)
    .map((id) => sources.find((source) => source.id === id))
    .filter((source): source is NonNullable<typeof source> => Boolean(source));

  if (!matched.length) return `Routes generated ${formatShortDate(payload.routeConfig?.generatedAt ?? payload.generatedAt)}`;

  const stale = matched.find((source) => source.status !== "ok");
  const newest = matched
    .map((source) => new Date(source.fetchedAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  const dateText = newest ? formatShortDate(new Date(newest).toISOString()) : "unknown";
  return stale ? `Last checked ${dateText}; ${stale.id} has a warning` : `Last checked ${dateText}`;
}

function costAxisLabel(costMode: CostMode) {
  return costMode === "task" ? "Intelligence benchmark cost" : "Blended route cost per 1M tokens";
}

function costTableLabel(costMode: CostMode) {
  return costMode === "task" ? "Task cost" : "Cost/1M";
}

function costCardSuffix(costMode: CostMode) {
  return costMode === "task" ? "to run Intelligence Index" : "per 1M blended";
}

function costSuffix(costMode: CostMode) {
  return costMode === "task" ? "" : "/ 1M";
}

function costValueUnit(costMode: CostMode, unit = "usd_per_1m_tokens") {
  return costMode === "task" ? (unit === "credits_per_1m_tokens" ? "credit" : "$") : valueUnitLabel(unit);
}

function costModeSourceNote(variant: ScoredVariant, costMode: CostMode) {
  if (costMode === "token") return variant.pricing.source;
  return "Task cost and task time use Artificial Analysis Intelligence Index token counts; task time estimates benchmark output generation from this route's effective output speed.";
}

function speedRangeLabel(costMode: CostMode) {
  return costMode === "task" ? "Task time range" : "Speed range";
}

function speedTableLabel(costMode: CostMode) {
  return costMode === "task" ? "Task time" : "tok/s";
}

function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  if (value < 60) return `${formatNumber(value, value < 10 ? 1 : 0)}s`;
  const minutes = value / 60;
  if (minutes < 60) return `${formatNumber(minutes, minutes < 10 ? 1 : 0)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${formatNumber(hours, hours < 10 ? 1 : 0)}h`;
  const days = hours / 24;
  return `${formatNumber(days, days < 10 ? 1 : 0)}d`;
}

function formatSpeedValue(variant: ScoredVariant, costMode: CostMode) {
  if (costMode === "task") return formatDuration(variant.taskCompletionSeconds);
  return `${formatNumber(variant.effectivePerformance.outputTokensPerSecond)} tok/s`;
}

function readStoredOverlays() {
  try {
    const raw = window.localStorage.getItem(OVERLAY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((overlay) => normalizeProviderOverlay(overlay)).filter(Boolean);
  } catch {
    return [];
  }
}

function writeStoredOverlays(overlays: ProviderOverlay[]) {
  window.localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(overlays));
}

function normalizeProviderOverlay(raw: unknown, fallbackName = "Imported provider"): ProviderOverlay {
  if (!isRecord(raw)) throw new Error("Overlay must be a JSON object.");
  const provider = cleanText(raw.provider) || cleanText(raw.name) || "Imported Provider";
  const name = cleanText(raw.name) || provider || fallbackName;
  const rawModels = Array.isArray(raw.models) ? raw.models : [];
  const models = rawModels
    .map((model, index) => normalizeOverlayModel(model, index))
    .filter((model): model is ProviderOverlayModel => Boolean(model));

  if (!models.length) {
    throw new Error("Overlay must include at least one model.");
  }

  return {
    version: 1,
    kind: "model-route-overlay",
    id: slugify(cleanText(raw.id) || provider),
    name,
    provider,
    fetchedAt: cleanText(raw.fetchedAt) || null,
    pricingMode: "public-match",
    route: cleanText(raw.route) || "imported-provider",
    models
  };
}

function normalizeOverlayModel(raw: unknown, index: number): ProviderOverlayModel | null {
  if (!isRecord(raw)) return null;
  const label = cleanText(raw.label) || cleanText(raw.model) || cleanText(raw.name);
  if (!label) return null;

  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.map(cleanText).filter(Boolean)
    : [];

  return {
    id: cleanText(raw.id) || slugify(`${label}-${index}`),
    label,
    model: cleanText(raw.model) || label,
    providerHint: cleanText(raw.providerHint) || null,
    aliases,
    contextWindow: numberOrNull(raw.contextWindow),
    maxOutputTokens: numberOrNull(raw.maxOutputTokens),
    limits: isRecord(raw.limits) ? raw.limits as Record<string, number | string | null> : undefined,
    benchmark: normalizeOverlayBenchmark(raw.benchmark),
    benchmarks: normalizeOverlayBenchmarks(raw.benchmarks)
  };
}

function normalizeOverlayBenchmarks(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeOverlayBenchmark).filter((benchmark): benchmark is NonNullable<typeof benchmark> => Boolean(benchmark));
}

function normalizeOverlayBenchmark(raw: unknown) {
  if (!isRecord(raw)) return null;
  const id = cleanText(raw.id);
  const name = cleanText(raw.name);
  if (!id || !name) return null;

  const basePricing = isRecord(raw.basePricing) ? raw.basePricing : {};
  const performance = isRecord(raw.performance) ? raw.performance : {};
  const intelligenceIndexCost = isRecord(raw.intelligenceIndexCost) ? raw.intelligenceIndexCost : {};
  const intelligenceIndexTokenCounts = isRecord(raw.intelligenceIndexTokenCounts) ? raw.intelligenceIndexTokenCounts : {};
  const evaluations = isRecord(raw.evaluations)
    ? Object.fromEntries(Object.entries(raw.evaluations).map(([key, value]) => [key, numberOrNull(value)]))
    : {};

  return {
    id,
    name,
    slug: cleanText(raw.slug) || slugify(name),
    releaseDate: cleanText(raw.releaseDate) || null,
    creator: cleanText(raw.creator) || "Unknown",
    creatorSlug: cleanText(raw.creatorSlug) || null,
    evaluations,
    basePricing: {
      blended3To1: numberOrNull(basePricing.blended3To1),
      blended7To2To1: numberOrNull(basePricing.blended7To2To1),
      input: numberOrNull(basePricing.input),
      output: numberOrNull(basePricing.output)
    },
    performance: {
      outputTokensPerSecond: numberOrNull(performance.outputTokensPerSecond),
      timeToFirstTokenSeconds: numberOrNull(performance.timeToFirstTokenSeconds),
      timeToFirstAnswerTokenSeconds: numberOrNull(performance.timeToFirstAnswerTokenSeconds)
    },
    intelligenceIndexCost: {
      total: numberOrNull(intelligenceIndexCost.total),
      input: numberOrNull(intelligenceIndexCost.input),
      output: numberOrNull(intelligenceIndexCost.output),
      reasoning: numberOrNull(intelligenceIndexCost.reasoning),
      answer: numberOrNull(intelligenceIndexCost.answer)
    },
    intelligenceIndexTokenCounts: {
      input: numberOrNull(intelligenceIndexTokenCounts.input),
      output: numberOrNull(intelligenceIndexTokenCounts.output),
      reasoning: numberOrNull(intelligenceIndexTokenCounts.reasoning),
      answer: numberOrNull(intelligenceIndexTokenCounts.answer)
    }
  };
}

function buildOverlayVariants(payload: ModelsPayload, overlays: ProviderOverlay[]) {
  if (!overlays.length) return [];
  const publicVariants = payload.variants;

  return overlays.flatMap((overlay) =>
    overlay.models.flatMap((model) => {
      const matches = findPublicVariantMatches(model, publicVariants);
      if (!matches.length) return [];
      const overlayId = overlay.id || slugify(overlay.provider);
      const modelId = model.id || slugify(model.label);
      const overlayBenchmarks = overlayModelBenchmarks(model);
      if (overlayBenchmarks.length) {
        return overlayBenchmarks.map((benchmark) =>
          createOverlayVariant(matches[0], overlay, model, overlayId, modelId, benchmark, overlayBenchmarks.length > 1)
        );
      }
      return matches.map((match) => createOverlayVariant(match, overlay, model, overlayId, modelId, null, matches.length > 1));
    })
  );
}

type OverlayDiagnostics = {
  id: string;
  provider: string;
  imported: number;
  priced: number;
  benchmarked: number;
};

type BenchmarkGap = {
  id: string;
  label: string;
  provider: string;
  route: string;
  sourceProvider: string | null;
  sourceRoute: string | null;
  sourceLabel: string | null;
};

function buildOverlayDiagnostics(payload: ModelsPayload, overlays: ProviderOverlay[]): OverlayDiagnostics[] {
  const publicVariants = payload.variants;
  return overlays.map((overlay) => {
    let priced = 0;
    let benchmarked = 0;

    for (const model of overlay.models) {
      const matches = findPublicVariantMatches(model, publicVariants);
      if (!matches.length) continue;
      priced += 1;
      if (overlayModelBenchmarks(model).length || matches.some((match) => match.aaMatched && match.model)) {
        benchmarked += 1;
      }
    }

    return {
      id: overlay.id || slugify(overlay.provider),
      provider: overlay.provider,
      imported: overlay.models.length,
      priced,
      benchmarked
    };
  });
}

function buildBenchmarkGaps(variants: ModelVariant[]): BenchmarkGap[] {
  return variants
    .filter((variant) => hasRoutePricing(variant) && (!variant.aaMatched || !variant.model))
    .map((variant) => {
      const metadata = variant.metadata ?? {};
      return {
        id: variant.id,
        label: variant.label,
        provider: variant.provider,
        route: variant.route,
        sourceProvider: typeof metadata.priceMatchedProvider === "string" ? metadata.priceMatchedProvider : null,
        sourceRoute: typeof metadata.priceMatchedRoute === "string" ? metadata.priceMatchedRoute : null,
        sourceLabel: typeof metadata.priceMatchedLabel === "string" ? metadata.priceMatchedLabel : null
      };
    })
    .sort((a, b) => [a.provider, a.route, a.label].join("|").localeCompare([b.provider, b.route, b.label].join("|")));
}

function hasRoutePricing(variant: ModelVariant) {
  return (
    variant.pricing.input !== null &&
    variant.pricing.input !== undefined &&
    variant.pricing.output !== null &&
    variant.pricing.output !== undefined
  );
}

function createOverlayVariant(
  publicVariant: ModelVariant,
  overlay: ProviderOverlay,
  model: ProviderOverlayModel,
  overlayId: string,
  modelId: string,
  benchmarkOverride: ProviderOverlayModel["benchmark"] = null,
  hasBenchmarkSiblings = false
): ModelVariant {
  const benchmark = benchmarkOverride ?? model.benchmark ?? publicVariant.model;
  const speedMultiplier = Number(publicVariant.options?.speedMultiplier ?? 1);
  const baseSpeed = benchmark?.performance.outputTokensPerSecond ?? null;
  const benchmarkSuffix = benchmark ? benchmarkVariantSuffix(benchmark.name) : "";
  return {
    ...publicVariant,
    id: `overlay-${overlayId}-${modelId}-${publicVariant.id}${hasBenchmarkSiblings && benchmark ? `-${slugify(benchmark.slug || benchmark.id || benchmark.name)}` : ""}`,
    label: hasBenchmarkSiblings && benchmark ? benchmark.name : publicVariant.label,
    provider: overlay.provider,
    route: overlay.route || "imported-provider",
    aaMatched: Boolean(benchmark),
    model: benchmark,
    options: {
      ...(publicVariant.options ?? {}),
      ...(benchmark ? benchmarkOptionsFromName(benchmark.name) : {})
    },
    effectivePerformance: {
      outputTokensPerSecond:
        baseSpeed === null ? null : Number((baseSpeed * speedMultiplier).toFixed(3)),
      baseOutputTokensPerSecond: baseSpeed,
      speedMultiplier
    },
    taskTags: uniqueSorted([
      ...(publicVariant.taskTags ?? []),
      "imported-provider",
      "provider-overlay",
      overlay.provider,
      model.providerHint ?? ""
    ].map(slugify)),
    pricing: {
      ...publicVariant.pricing,
      source: `${publicVariant.pricing.source} Matched to imported provider availability; pricing remains public-source pricing.`
    },
    metadata: {
      ...(publicVariant.metadata ?? {}),
      importedOverlay: true,
      overlayId,
      overlayName: overlay.name,
      overlayProvider: overlay.provider,
      overlayFetchedAt: overlay.fetchedAt ?? null,
      importedModelLabel: model.label,
      importedModelAliases: model.aliases ?? [],
      providerHint: model.providerHint ?? null,
      benchmarkSource: benchmarkOverride || model.benchmark ? "overlay-export" : "public-route",
      benchmarkVariant: benchmarkSuffix || publicVariant.metadata?.benchmarkVariant,
      priceMatchedProvider: publicVariant.provider,
      priceMatchedRoute: publicVariant.route,
      priceMatchedLabel: publicVariant.label,
      contextWindow: model.contextWindow ?? publicVariant.metadata?.contextWindow,
      maxOutputTokens: model.maxOutputTokens ?? publicVariant.metadata?.maxOutputTokens,
      limits: model.limits
    }
  };
}

function overlayModelBenchmarks(model: ProviderOverlayModel) {
  return model.benchmarks?.length ? model.benchmarks : model.benchmark ? [model.benchmark] : [];
}

function findPublicVariantMatches(model: ProviderOverlayModel, variants: ModelVariant[]) {
  const modelKeys = overlayModelKeys(model);
  const candidates = variants.filter((variant) =>
    publicVariantKeys(variant).some((key) => modelKeys.has(key))
  );
  if (!candidates.length) return [];

  const sorted = candidates.sort((a, b) => matchRank(a, model) - matchRank(b, model));
  const best = sorted[0];
  const bestRank = matchRank(best, model);
  return sorted.filter(
    (candidate) =>
      matchRank(candidate, model) === bestRank &&
      candidate.provider === best.provider &&
      candidate.route === best.route &&
      candidate.modelSlug === best.modelSlug
  );
}

function overlayModelKeys(model: ProviderOverlayModel) {
  return new Set(
    [model.id, model.label, model.model, ...(model.aliases ?? [])]
      .flatMap((value) => [value, stripProviderPrefix(value)])
      .flatMap(candidateKeys)
      .filter(Boolean)
  );
}

function publicVariantKeys(variant: ModelVariant) {
  return [variant.id, variant.label, variant.modelSlug, variant.model?.id, variant.model?.slug, variant.model?.name]
    .flatMap(candidateKeys)
    .filter(Boolean);
}

function matchRank(variant: ModelVariant, model: ProviderOverlayModel) {
  let rank = providerHintMatches(variant, model.providerHint) ? 0 : 50;
  if (variant.provider === "Anthropic") rank += 1;
  else if (variant.provider === "Azure AI Foundry") rank += 2;
  else if (variant.provider === "Codex") rank += 3;
  else if (variant.provider === "GitHub Copilot") rank += 4;
  else rank += 10;
  return rank;
}

function providerHintMatches(variant: ModelVariant, providerHint: string | null | undefined) {
  const hint = canonicalKey(providerHint);
  if (!hint) return true;
  const provider = canonicalKey(variant.provider);
  const route = canonicalKey(variant.route);
  if (hint.includes("anthropic") || hint.includes("claude")) return provider.includes("anthropic");
  if (hint.includes("azure")) return provider.includes("azure");
  if (hint.includes("github")) return provider.includes("github");
  if (hint.includes("codex")) return provider.includes("codex") || route.includes("codex");
  return provider.includes(hint) || route.includes(hint);
}

function stripProviderPrefix(value: unknown) {
  const text = cleanText(value);
  return text.includes("/") ? text.split("/").slice(1).join("/") : text;
}

function canonicalKey(value: unknown) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function candidateKeys(value: unknown) {
  const text = cleanText(value);
  if (!text) return [];
  const noParens = text.replace(/\([^)]*\)/g, " ");
  const keys = [
    canonicalKey(text),
    canonicalKey(noParens),
    ...orderInvariantAliases(text),
    ...orderInvariantAliases(noParens),
    ...semanticAliases(text),
    ...semanticAliases(noParens)
  ];
  return uniqueOrdered(keys.filter(Boolean));
}

function semanticAliases(value: unknown) {
  const key = canonicalKey(value);
  if (!key) return [];
  const aliases = new Set([key]);
  const descriptorTrimmed = key.replace(
    /(preview|nonreasoning|reasoning|higheffort|maxeffort|adaptive|thinking|high|medium|low|effort|xhigh)/g,
    ""
  );
  if (descriptorTrimmed) aliases.add(descriptorTrimmed);
  for (const alias of orderInvariantAliases(descriptorTrimmed)) aliases.add(alias);

  for (const candidate of [...aliases]) {
    const compactDate = candidate.replace(/(20\d{2})(\d{2})(\d{2})/g, "$2$3");
    if (compactDate !== candidate) aliases.add(compactDate);
    const withoutTrailingDate = candidate.replace(/(?:20\d{2})?\d{4}$/g, "");
    if (withoutTrailingDate && withoutTrailingDate !== candidate) aliases.add(withoutTrailingDate);
  }

  return [...aliases];
}

function orderInvariantAliases(value: unknown) {
  const tokens = String(value ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .match(/[a-z]+|\d+/g);
  if (!tokens?.length) return [];
  const normalized = normalizeVersionTokens(tokens);
  const descriptorTrimmed = normalized.filter(
    (token) => !["preview", "non", "reasoning", "higheffort", "maxeffort", "adaptive", "thinking", "high", "medium", "low", "effort", "xhigh"].includes(token)
  );
  const aliases = [normalized, descriptorTrimmed]
    .filter((items) => items.length)
    .map((items) => [...items].sort().join(""));
  return uniqueOrdered(aliases);
}

function normalizeVersionTokens(tokens: string[]) {
  const normalized: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    if (/^\d$/.test(current) && /^\d$/.test(next)) {
      normalized.push(`${current}${next}`);
      index += 1;
    } else {
      normalized.push(current);
    }
  }
  return normalized;
}

function benchmarkVariantSuffix(name: unknown) {
  const match = cleanText(name).match(/\(([^)]+)\)/);
  return match?.[1] ?? "";
}

function benchmarkOptionsFromName(name: unknown) {
  const suffix = benchmarkVariantSuffix(name).toLowerCase();
  if (!suffix) return {};

  const options: Partial<ModelVariant["options"]> = {};
  if (suffix.includes("adaptive reasoning")) options.reasoning = "adaptive reasoning";
  else if (suffix.includes("non-reasoning")) options.reasoning = "non-reasoning";
  else if (suffix.includes("reasoning")) options.reasoning = "reasoning";

  if (suffix.includes("max effort")) options.effort = "max";
  else if (suffix.includes("high effort")) options.effort = "high";
  else if (suffix.includes("medium effort")) options.effort = "medium";
  else if (suffix.includes("low effort")) options.effort = "low";

  return options;
}

function slugify(value: unknown) {
  return cleanText(value)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function numberOrNull(value: unknown) {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function uniqueOrdered(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function overlaySummary(
  overlay: ProviderOverlay,
  diagnostics: OverlayDiagnostics[],
  fallbackCounts: Map<string, number>
) {
  const overlayId = overlay.id || slugify(overlay.provider);
  const diagnostic = diagnostics.find((item) => item.id === overlayId);
  if (!diagnostic) {
    const priced = fallbackCounts.get(overlayId) ?? 0;
    return `${priced} priced`;
  }
  return `${diagnostic.benchmarked}/${diagnostic.priced} benchmarked`;
}

function benchmarkGapDescription(item: BenchmarkGap) {
  if (item.sourceProvider) {
    return `Imported route priced through ${item.sourceProvider} / ${item.sourceLabel ?? item.sourceRoute}, but no Artificial Analysis benchmark matched.`;
  }
  return `Pricing exists for ${item.route}, but no Artificial Analysis benchmark matched.`;
}

function MetricCard({
  icon,
  label,
  value,
  sub
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-icon">{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{sub}</span>
      </div>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  children
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

function RangeField({
  label,
  value,
  domain,
  suffix,
  formatValue,
  onChange
}: {
  label: string;
  value: NumericRange;
  domain: NumericDomain;
  suffix?: string;
  formatValue?: (value: number) => string;
  onChange: (range: NumericRange) => void;
}) {
  const [draftMin, setDraftMin] = useState(formatEditableNumber(value.min, domain.decimals));
  const [draftMax, setDraftMax] = useState(formatEditableNumber(value.max, domain.decimals));
  const inputStep = formatEditableNumber(domain.inputStep, domain.decimals);
  const summaryValue = (number: number) =>
    formatValue ? formatValue(number) : `${formatEditableNumber(number, domain.decimals)}${suffix ? ` ${suffix}` : ""}`;

  useEffect(() => {
    setDraftMin(formatEditableNumber(value.min, domain.decimals));
    setDraftMax(formatEditableNumber(value.max, domain.decimals));
  }, [domain.decimals, value.max, value.min]);

  function updateBoundary(boundary: "min" | "max", nextValue: number) {
    if (!Number.isFinite(nextValue)) return;
    onChange(
      constrainRange(
        {
          min: boundary === "min" ? nextValue : value.min,
          max: boundary === "max" ? nextValue : value.max
        },
        domain,
        boundary
      )
    );
  }

  function commitDraft(boundary: "min" | "max") {
    const draft = boundary === "min" ? draftMin : draftMax;
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed)) {
      updateBoundary(boundary, parsed);
      return;
    }

    if (boundary === "min") setDraftMin(formatEditableNumber(value.min, domain.decimals));
    else setDraftMax(formatEditableNumber(value.max, domain.decimals));
  }

  function commitOnEnter(event: React.KeyboardEvent<HTMLInputElement>, boundary: "min" | "max") {
    if (event.key === "Enter") {
      commitDraft(boundary);
      event.currentTarget.blur();
    }
  }

  const rangeStyle = {
    "--range-min": `${percentOfDomain(value.min, domain)}%`,
    "--range-max": `${percentOfDomain(value.max, domain)}%`
  } as React.CSSProperties;

  return (
    <div className="range-field" style={rangeStyle}>
      <div className="range-field-head">
        <span>{label}</span>
        <b>
          {summaryValue(value.min)} - {summaryValue(value.max)}
        </b>
      </div>
      <div className="range-slider">
        <span className="range-track" aria-hidden="true" />
        <input
          aria-label={`${label} minimum`}
          type="range"
          min={domain.min}
          max={domain.max}
          step="any"
          value={value.min}
          onChange={(event) => updateBoundary("min", Number(event.target.value))}
        />
        <input
          aria-label={`${label} maximum`}
          type="range"
          min={domain.min}
          max={domain.max}
          step="any"
          value={value.max}
          onChange={(event) => updateBoundary("max", Number(event.target.value))}
        />
      </div>
      <div className="range-input-grid">
        <label>
          <span>Min</span>
          <input
            aria-label={`${label} precise minimum`}
            type="number"
            inputMode="decimal"
            min={domain.min}
            max={domain.max}
            step={inputStep}
            value={draftMin}
            onBlur={() => commitDraft("min")}
            onChange={(event) => setDraftMin(event.target.value)}
            onKeyDown={(event) => commitOnEnter(event, "min")}
          />
        </label>
        <label>
          <span>Max</span>
          <input
            aria-label={`${label} precise maximum`}
            type="number"
            inputMode="decimal"
            min={domain.min}
            max={domain.max}
            step={inputStep}
            value={draftMax}
            onBlur={() => commitDraft("max")}
            onChange={(event) => setDraftMax(event.target.value)}
            onKeyDown={(event) => commitOnEnter(event, "max")}
          />
        </label>
      </div>
    </div>
  );
}

function bestBy(points: ScoredVariant[], getter: (point: ScoredVariant) => number | null) {
  return points.reduce<ScoredVariant | null>((best, point) => {
    const value = getter(point);
    if (value === null || !Number.isFinite(value)) return best;
    if (!best) return point;
    const bestValue = getter(best);
    return bestValue === null || value > bestValue ? point : best;
  }, null);
}

function bestByLowest(points: ScoredVariant[], getter: (point: ScoredVariant) => number | null) {
  return points.reduce<ScoredVariant | null>((best, point) => {
    const value = getter(point);
    if (value === null || !Number.isFinite(value)) return best;
    if (!best) return point;
    const bestValue = getter(best);
    return bestValue === null || !Number.isFinite(bestValue) || value < bestValue ? point : best;
  }, null);
}

function cheapestViable(points: ScoredVariant[]) {
  const usable = points.filter((point) => point.metricValue !== null && point.comparisonCost !== null);
  if (!usable.length) return null;
  const maxMetric = Math.max(...usable.map((point) => point.metricValue!));
  const threshold = maxMetric * 0.8;
  return usable
    .filter((point) => point.metricValue! >= threshold)
    .sort((a, b) => a.comparisonCost! - b.comparisonCost!)[0];
}

function App() {
  const { payload, loading, error, reload } = useModels();
  const overlayInputRef = useRef<HTMLInputElement | null>(null);
  const knownProvidersRef = useRef<Set<string>>(new Set());
  const providerFiltersTouchedRef = useRef(false);
  const previousFilterDomainsRef = useRef<RangeDomains | null>(null);
  const [query, setQuery] = useState("");
  const [costMode, setCostMode] = useState<CostMode>("task");
  const [profileId, setProfileId] = useState("");
  const [metric, setMetric] = useState(DEFAULT_METRIC);
  const [activeProviders, setActiveProviders] = useState<Set<string>>(new Set());
  const [overlays, setOverlays] = useState<ProviderOverlay[]>(() => readStoredOverlays());
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [showBenchmarkDiagnostics, setShowBenchmarkDiagnostics] = useState(false);
  const [rangeFilters, setRangeFilters] = useState<RangeFilters | null>(null);
  const [showFrontier, setShowFrontier] = useState(true);
  const [xAxisMode, setXAxisMode] = useState<XAxisMode>("log");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const overlayVariants = useMemo(() => {
    if (!payload) return [];
    return buildOverlayVariants(payload, overlays);
  }, [overlays, payload]);

  const allVariants = useMemo(() => {
    if (!payload) return [];
    return [...payload.variants, ...overlayVariants];
  }, [overlayVariants, payload]);

  const overlayRouteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const variant of overlayVariants) {
      const overlayId = typeof variant.metadata?.overlayId === "string" ? variant.metadata.overlayId : null;
      if (overlayId) counts.set(overlayId, (counts.get(overlayId) ?? 0) + 1);
    }
    return counts;
  }, [overlayVariants]);

  const overlayDiagnostics = useMemo(() => {
    if (!payload) return [];
    return buildOverlayDiagnostics(payload, overlays);
  }, [overlays, payload]);

  const benchmarkGaps = useMemo(() => buildBenchmarkGaps(allVariants), [allVariants]);

  useEffect(() => {
    writeStoredOverlays(overlays);
  }, [overlays]);

  useEffect(() => {
    if (!payload) return;
    setProfileId((existing) => existing || payload.defaultProfileId);
    setMetric((existing) => (payload.metricKeys.includes(existing) ? existing : DEFAULT_METRIC));
  }, [payload]);

  useEffect(() => {
    if (!payload) return;
    const providersNow = new Set(allVariants.map((variant) => variant.provider));
    const previouslyKnownProviders = knownProvidersRef.current;
    setActiveProviders((existing) => {
      if (!providerFiltersTouchedRef.current && existing.size === 0) return new Set(providersNow);
      const next = new Set([...existing].filter((provider) => providersNow.has(provider)));
      for (const provider of providersNow) {
        if (!previouslyKnownProviders.has(provider)) next.add(provider);
      }
      return next;
    });
    knownProvidersRef.current = providersNow;
  }, [allVariants, payload]);

  const profile: TaskProfile | null = useMemo(() => {
    if (!payload) return null;
    return payload.profiles.find((item) => item.id === profileId) ?? payload.profiles[0] ?? null;
  }, [payload, profileId]);

  const metricOptions = useMemo(() => {
    if (!payload) return [];
    const preferred = preferredMetrics.filter((key) => payload.metricKeys.includes(key));
    const rest = payload.metricKeys.filter((key) => !preferred.includes(key));
    return [...preferred, ...rest];
  }, [payload]);

  const scored = useMemo(() => {
    if (!payload || !profile) return [];
    return scoreVariants(allVariants, profile, metric, costMode);
  }, [allVariants, costMode, payload, profile, metric]);

  const filterDomains = useMemo<RangeDomains>(() => {
    return {
      score: domainFromValues(scored.map((variant) => variant.metricValue), {
        fallbackMax: 1,
        inputStep: 0.001,
        decimals: 3
      }),
      price: domainFromValues(
        scored.map((variant) =>
          variant.comparisonCost !== null && variant.comparisonCost > 0 ? variant.comparisonCost : null
        ),
        {
          fallbackMax: 1,
          inputStep: 0.0001,
          decimals: 4
        }
      ),
      speed: domainFromValues(scored.map((variant) => variant.comparisonSpeedValue), {
        fallbackMax: 1,
        inputStep: costMode === "task" ? 1 : 0.001,
        decimals: costMode === "task" ? 1 : 3
      })
    };
  }, [costMode, scored]);

  const effectiveRangeFilters = rangeFilters ?? rangesFromDomains(filterDomains);

  useEffect(() => {
    if (!payload || !profile) return;
    setRangeFilters((existing) => {
      const reconciled = reconcileRangeFilters(
        existing ?? rangesFromDomains(filterDomains),
        filterDomains,
        previousFilterDomainsRef.current
      );
      previousFilterDomainsRef.current = filterDomains;
      return reconciled;
    });
  }, [filterDomains, payload, profile]);

  const providers = useMemo(() => {
    return Array.from(new Set(scored.map((variant) => variant.provider))).sort();
  }, [scored]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const speedRangeActive = !rangesAreClose(effectiveRangeFilters.speed, filterDomains.speed);
    return scored.filter((variant) => {
      const text = [
        variant.label,
        variant.provider,
        variant.route,
        variant.model?.name,
        variant.options.reasoning,
        variant.options.effort,
        ...(variant.taskTags || [])
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        activeProviders.has(variant.provider) &&
        (!normalizedQuery || text.includes(normalizedQuery)) &&
        valueInRange(variant.metricValue, effectiveRangeFilters.score) &&
        valueInRange(variant.comparisonCost, effectiveRangeFilters.price) &&
        variant.comparisonCost !== null &&
        variant.comparisonCost > 0 &&
        (!speedRangeActive || valueInRange(variant.comparisonSpeedValue, effectiveRangeFilters.speed))
      );
    });
  }, [activeProviders, effectiveRangeFilters, filterDomains.speed, query, scored]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => (b.valueScore ?? -Infinity) - (a.valueScore ?? -Infinity));
  }, [filtered]);

  const frontier = useMemo(() => paretoFrontier(filtered), [filtered]);
  const selected = sorted.find((variant) => variant.id === selectedId) ?? sorted[0] ?? null;
  const bestValue = bestBy(filtered, (point) => point.valueScore);
  const bestSpeed =
    costMode === "task"
      ? bestByLowest(filtered, (point) => point.taskCompletionSeconds)
      : bestBy(filtered, (point) => point.effectivePerformance.outputTokensPerSecond);
  const bestMetric = bestBy(filtered, (point) => point.metricValue);
  const cheapFit = cheapestViable(filtered);
  const activeCostAxisLabel = costAxisLabel(costMode);
  const activeCostSuffix = costSuffix(costMode);

  function updateRangeFilter(key: RangeFilterKey, range: NumericRange) {
    setRangeFilters((existing) => ({
      ...(existing ?? rangesFromDomains(filterDomains)),
      [key]: range
    }));
  }

  function toggleProvider(provider: string) {
    providerFiltersTouchedRef.current = true;
    setActiveProviders((existing) => {
      const next = new Set(existing);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  }

  async function importOverlayFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const overlay = normalizeProviderOverlay(JSON.parse(text), file.name);
      setOverlays((existing) => [overlay, ...existing.filter((item) => item.id !== overlay.id)]);
      setOverlayError(null);
    } catch (importError) {
      setOverlayError(importError instanceof Error ? importError.message : String(importError));
    }
  }

  function removeOverlay(id: string | undefined) {
    if (!id) return;
    setOverlays((existing) => existing.filter((overlay) => overlay.id !== id));
  }

  if (loading && !payload) {
    return (
      <main className="loading-shell">
        <div className="loader-mark" />
        <span>Loading model market data</span>
      </main>
    );
  }

  if (error && !payload) {
    return (
      <main className="loading-shell error-shell">
        <strong>Could not load data</strong>
        <span>{error}</span>
        <button onClick={() => reload()}>
          <RefreshCw size={16} />
          Retry
        </button>
      </main>
    );
  }

  if (!payload || !profile) return null;

  return (
    <main className="app-shell">
      <aside className="side-panel">
        <div className="brand-lockup">
          <div className="brand-mark">
            <GitCompareArrows size={23} />
          </div>
          <div>
            <h1>Model Routes</h1>
            <p>Intelligence per dollar</p>
          </div>
        </div>

        <div className="control-stack">
          <label className="search-box">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models, routes, tags"
            />
          </label>

          <SelectField label="Compare" value={costMode} onChange={(value) => setCostMode(value as CostMode)}>
            {costModeOptions.map((item) => (
              <option value={item.mode} key={item.mode}>
                {item.label}
              </option>
            ))}
          </SelectField>

          {costMode === "token" ? (
            <SelectField label="Task profile" value={profileId} onChange={setProfileId}>
              {payload.profiles.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </SelectField>
          ) : null}

          <SelectField label="Score" value={metric} onChange={setMetric}>
            {metricOptions.map((key) => (
              <option value={key} key={key}>
                {labelForMetric(key)}
              </option>
            ))}
          </SelectField>

          <div className="range-filter-group" aria-label="Range filters">
            <RangeField
              label={`${labelForMetric(metric)} range`}
              value={effectiveRangeFilters.score}
              domain={filterDomains.score}
              onChange={(range) => updateRangeFilter("score", range)}
            />
            <RangeField
              label={`${costTableLabel(costMode)} range`}
              value={effectiveRangeFilters.price}
              domain={filterDomains.price}
              formatValue={(value) => formatPrice(value)}
              onChange={(range) => updateRangeFilter("price", range)}
            />
            <RangeField
              label={speedRangeLabel(costMode)}
              value={effectiveRangeFilters.speed}
              domain={filterDomains.speed}
              suffix={costMode === "token" ? "tok/s" : undefined}
              formatValue={costMode === "task" ? formatDuration : undefined}
              onChange={(range) => updateRangeFilter("speed", range)}
            />
          </div>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={showFrontier}
              onChange={(event) => setShowFrontier(event.target.checked)}
            />
            <span>Pareto frontier</span>
          </label>
        </div>

        <section className="provider-filter" aria-label="Provider filters">
          <div className="section-label">
            <Filter size={15} />
            Providers
          </div>
          <div className="provider-list">
            {providers.map((provider) => (
              <label className="provider-chip" key={provider}>
                <input
                  type="checkbox"
                  checked={activeProviders.has(provider)}
                  onChange={() => toggleProvider(provider)}
                />
                <span style={{ background: providerColor(provider) }} />
                {provider}
              </label>
            ))}
          </div>
        </section>

        <section className="overlay-panel" aria-label="Provider overlays">
          <div className="section-label">
            <Upload size={15} />
            Overlays
          </div>
          <input
            ref={overlayInputRef}
            className="file-input-hidden"
            type="file"
            accept="application/json,.json"
            onChange={importOverlayFile}
          />
          <div className="overlay-actions">
            <button type="button" onClick={() => overlayInputRef.current?.click()}>
              <Upload size={14} />
              Import
            </button>
            {overlays.length > 0 ? (
              <button type="button" onClick={() => setOverlays([])}>
                <X size={14} />
                Clear
              </button>
            ) : null}
          </div>
          {overlayError ? <p className="overlay-error">{overlayError}</p> : null}
          {overlays.length > 0 ? (
            <div className="overlay-list">
              {overlays.map((overlay) => (
                <div className="overlay-item" key={overlay.id}>
                  <div>
                    <strong>{overlay.provider}</strong>
                    <span>{overlaySummary(overlay, overlayDiagnostics, overlayRouteCounts)}</span>
                  </div>
                  <button type="button" onClick={() => removeOverlay(overlay.id)} title={`Remove ${overlay.provider}`}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="overlay-empty">No overlays loaded</p>
          )}
        </section>

        {costMode === "token" ? (
          <section className="blend-panel">
            <div className="section-label">
              <Settings2 size={15} />
              Token blend
            </div>
            <div className="blend-bars">
              <div>
                <span>Cached</span>
                <b>{Math.round(profile.tokenBlend.cachedInput * 100)}%</b>
              </div>
              <meter min="0" max="1" value={profile.tokenBlend.cachedInput} />
              <div>
                <span>Fresh</span>
                <b>{Math.round(profile.tokenBlend.freshInput * 100)}%</b>
              </div>
              <meter min="0" max="1" value={profile.tokenBlend.freshInput} />
              <div>
                <span>Output</span>
                <b>{Math.round(profile.tokenBlend.output * 100)}%</b>
              </div>
              <meter min="0" max="1" value={profile.tokenBlend.output} />
            </div>
          </section>
        ) : null}

        <footer className="data-footnote">
          <div className="freshness-lines">
            <span>Routes {formatShortDate(payload.routeConfig?.generatedAt ?? payload.generatedAt)}</span>
            <span>{sourceSummary(payload)}</span>
            <span>
              <a href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">
                Artificial Analysis
              </a>{" "}
              {formatShortDate(payload.artificialAnalysis.fetchedAt)}
            </span>
          </div>
          <div className="data-footnote-actions">
            {benchmarkGaps.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowBenchmarkDiagnostics(true)}
                title={`${benchmarkGaps.length} priced route${benchmarkGaps.length === 1 ? "" : "s"} have no benchmark match`}
              >
                <CircleAlert size={14} />
                Benchmarks
              </button>
            ) : null}
            <button onClick={() => reload()} disabled={loading} title="Reload static data">
              <RefreshCw size={14} className={loading ? "spin" : ""} />
            </button>
          </div>
        </footer>
      </aside>

      {showBenchmarkDiagnostics ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowBenchmarkDiagnostics(false)}>
          <section
            className="diagnostics-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="benchmark-diagnostics-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <p>Global route diagnostics</p>
                <h2 id="benchmark-diagnostics-title">Missing benchmarks</h2>
              </div>
              <button type="button" onClick={() => setShowBenchmarkDiagnostics(false)} title="Close">
                <X size={16} />
              </button>
            </div>
            <div className="diagnostics-list">
              {benchmarkGaps.map((item) => (
                <div className="diagnostics-row" key={item.id}>
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.provider}</span>
                  </div>
                  <p>{benchmarkGapDescription(item)}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      <section className="main-panel">
        <header className="top-strip">
          <MetricCard
            icon={<CircleDollarSign size={19} />}
            label="Best value"
            value={bestValue ? bestValue.label : "n/a"}
            sub={
              bestValue
                ? `${formatNumber(bestValue.valueScore)} pts per ${costValueUnit(costMode, bestValue.pricing.unit)}`
                : "No matched route"
            }
          />
          <MetricCard
            icon={<Target size={19} />}
            label="Cheapest strong fit"
            value={cheapFit ? cheapFit.label : "n/a"}
            sub={
              cheapFit
                ? `${formatPrice(cheapFit.comparisonCost, cheapFit.pricing.unit)} ${costCardSuffix(costMode)}`
                : "No viable route"
            }
          />
          <MetricCard
            icon={<Sparkles size={19} />}
            label="Top score"
            value={bestMetric ? bestMetric.label : "n/a"}
            sub={bestMetric ? `${formatNumber(bestMetric.metricValue)} ${labelForMetric(metric)}` : "No score"}
          />
          <MetricCard
            icon={<Zap size={19} />}
            label="Fastest"
            value={bestSpeed ? bestSpeed.label : "n/a"}
            sub={
              bestSpeed
                ? costMode === "task"
                  ? `${formatDuration(bestSpeed.taskCompletionSeconds)} benchmark time`
                  : `${formatNumber(bestSpeed.effectivePerformance.outputTokensPerSecond)} tok/s`
                : costMode === "task"
                  ? "No task time data"
                  : "No speed data"
            }
          />
        </header>

        <section className="chart-panel">
          <div className="chart-head">
            <div>
              <p>Scatter</p>
              <h2>{labelForMetric(metric)} vs {costMode === "task" ? "task cost" : "token cost"}</h2>
            </div>
            <div className="chart-actions">
              <div className="chart-key">
                <span>
                  <Gauge size={15} />
                  size = {costMode === "task" ? "shorter task time" : "speed"}
                </span>
                <span>
                  <BarChart3 size={15} />
                  x = {xAxisMode === "linear" ? "linear" : "log-like"} {costMode === "task" ? "task cost" : "token cost"}
                </span>
              </div>
              <div className="axis-mode-toggle" aria-label="X-axis scale">
                {xAxisModeOptions.map(({ mode, label }) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={xAxisMode === mode}
                    onClick={() => setXAxisMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <ScatterPlot
            points={filtered}
            frontier={showFrontier ? frontier : []}
            selectedId={selected?.id ?? null}
            metricLabel={labelForMetric(metric)}
            costLabel={activeCostAxisLabel}
            costSuffix={activeCostSuffix}
            valueUnitForPoint={(point) => costValueUnit(costMode, point.pricing.unit)}
            speedLabel={costMode === "task" ? "Task time" : "Speed"}
            speedHigherIsBetter={costMode === "token"}
            formatSpeedForPoint={(point) => formatSpeedValue(point, costMode)}
            xAxisMode={xAxisMode}
            colorForProvider={providerColor}
            onSelect={setSelectedId}
          />
        </section>

        <section className="detail-grid">
          <article className="route-detail">
            {selected ? (
              <>
                <div className="detail-title">
                  <span style={{ background: providerColor(selected.provider) }} />
                  <div>
                    <p>{selected.provider}</p>
                    <h3>{selected.label}</h3>
                  </div>
                </div>
                <dl>
                  <div>
                    <dt>Route</dt>
                    <dd>{selected.route}</dd>
                  </div>
                  <div>
                    <dt>Reasoning</dt>
                    <dd>
                      {selected.options.reasoning}, {selected.options.effort}
                    </dd>
                  </div>
                  <div>
                    <dt>Speed option</dt>
                    <dd>{selected.options.speed}</dd>
                  </div>
                  <div>
                    <dt>{costMode === "task" ? "Task cost" : "Blended rate"}</dt>
                    <dd>{formatPrice(selected.comparisonCost, selected.pricing.unit)} {activeCostSuffix}</dd>
                  </div>
                  {costMode === "task" ? (
                    <>
                      <div>
                        <dt>Input cost</dt>
                        <dd>{formatPrice(selected.taskCost?.input, selected.pricing.unit)}</dd>
                      </div>
                      <div>
                        <dt>Output cost</dt>
                        <dd>{formatPrice(selected.taskCost?.output, selected.pricing.unit)}</dd>
                      </div>
                      <div>
                        <dt>Reasoning cost</dt>
                        <dd>{formatPrice(selected.taskCost?.reasoning, selected.pricing.unit)}</dd>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <dt>Input</dt>
                        <dd>{formatPrice(selected.pricing.input, selected.pricing.unit)}</dd>
                      </div>
                      <div>
                        <dt>Cached</dt>
                        <dd>{formatPrice(selected.pricing.cachedInput, selected.pricing.unit)}</dd>
                      </div>
                      <div>
                        <dt>Output</dt>
                        <dd>{formatPrice(selected.pricing.output, selected.pricing.unit)}</dd>
                      </div>
                    </>
                  )}
                  <div>
                    <dt>{costMode === "task" ? "Benchmark time" : "Output speed"}</dt>
                    <dd>{formatSpeedValue(selected, costMode)}</dd>
                  </div>
                </dl>
                <p className="price-source">{costModeSourceNote(selected, costMode)}</p>
                <p className="freshness-note">{variantFreshness(selected, payload)}</p>
              </>
            ) : (
              <span>No route selected</span>
            )}
          </article>

          <article className="rank-table">
            <div className="table-head">
              <h3>Ranked routes</h3>
              <span>{sorted.length} shown</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Route</th>
                    <th>Provider</th>
                    <th>Score</th>
                    <th>{costTableLabel(costMode)}</th>
                    <th>Value</th>
                    <th>{speedTableLabel(costMode)}</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((variant) => (
                    <tr
                      key={variant.id}
                      className={variant.id === selected?.id ? "selected-row" : ""}
                      onClick={() => setSelectedId(variant.id)}
                    >
                      <td>
                        <strong>{variant.label}</strong>
                        <span>{variant.options.effort}</span>
                      </td>
                      <td>{variant.provider}</td>
                      <td>{formatNumber(variant.metricValue)}</td>
                      <td>{formatPrice(variant.comparisonCost, variant.pricing.unit)}</td>
                      <td>{formatNumber(variant.valueScore)}</td>
                      <td>{formatSpeedValue(variant, costMode)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}

export default App;
