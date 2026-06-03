export type TokenBlend = {
  cachedInput: number;
  freshInput: number;
  output: number;
};

export type CostMode = "task" | "token";

export type TaskProfile = {
  id: string;
  name: string;
  description: string;
  tokenBlend: TokenBlend;
};

export type AaIntelligenceIndexCost = {
  total: number | null;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  answer: number | null;
};

export type AaIntelligenceIndexTokenCounts = {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  answer: number | null;
};

export type AaModel = {
  id: string;
  name: string;
  slug: string;
  releaseDate: string | null;
  creator: string;
  creatorSlug: string | null;
  evaluations: Record<string, number | null>;
  basePricing: {
    blended3To1: number | null;
    blended7To2To1: number | null;
    input: number | null;
    output: number | null;
  };
  performance: {
    outputTokensPerSecond: number | null;
    timeToFirstTokenSeconds: number | null;
    timeToFirstAnswerTokenSeconds: number | null;
  };
  intelligenceIndexCost?: AaIntelligenceIndexCost | null;
  intelligenceIndexTokenCounts?: AaIntelligenceIndexTokenCounts | null;
};

export type ModelVariant = {
  id: string;
  label: string;
  modelSlug: string;
  provider: string;
  route: string;
  taskTags: string[];
  options: {
    reasoning: string;
    effort: string;
    speed: string;
    speedMultiplier: number;
  };
  pricing: {
    input: number | null;
    cachedInput: number | null;
    output: number | null;
    cacheWrite?: number | null;
    cacheWrite1h?: number | null;
    unit?: string;
    source: string;
  };
  metadata?: Record<string, unknown>;
  aaMatched: boolean;
  model: AaModel | null;
  effectivePerformance: {
    outputTokensPerSecond: number | null;
    baseOutputTokensPerSecond: number | null;
    speedMultiplier: number;
  };
};

export type RouteConfigSource = {
  id: string;
  url: string;
  fetchedAt: string;
  status: "ok" | "error";
  count?: number | null;
  warning?: string;
  durationMs?: number;
};

export type ProviderOverlayModel = {
  id?: string;
  label: string;
  model?: string;
  providerHint?: string | null;
  aliases?: string[];
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  limits?: Record<string, number | string | null>;
  benchmark?: AaModel | null;
  benchmarks?: AaModel[];
};

export type ProviderOverlay = {
  version: number;
  kind?: "model-route-overlay";
  id?: string;
  name: string;
  provider: string;
  fetchedAt?: string | null;
  pricingMode?: "public-match";
  route?: string;
  models: ProviderOverlayModel[];
};

export type ModelsPayload = {
  generatedAt: string;
  artificialAnalysis: {
    endpoint: string;
    fetchedAt: string;
    source: string;
    warning: string | null;
    modelCount: number;
    promptOptions: Record<string, unknown> | null;
    websiteModels?: {
      url: string;
      fetchedAt: string | null;
      source: string;
      warning: string | null;
      modelCount: number;
    };
    attribution: string;
  };
  routeConfig?: {
    generatedAt: string | null;
    generatedBy: string | null;
    sources: RouteConfigSource[];
    warnings: string[];
  };
  profiles: TaskProfile[];
  defaultProfileId: string;
  metricKeys: string[];
  variants: ModelVariant[];
};

export type ScoredVariant = ModelVariant & {
  metricValue: number | null;
  blendedCost: number | null;
  taskCost: AaIntelligenceIndexCost | null;
  taskCompletionSeconds: number | null;
  comparisonCost: number | null;
  comparisonCostSource: "task" | "token";
  comparisonSpeedValue: number | null;
  valueScore: number | null;
};
