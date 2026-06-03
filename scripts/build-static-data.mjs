import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env"), quiet: true });
dotenv.config({ path: path.join(rootDir, ".env.local"), override: true, quiet: true });

const AA_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
const AA_MODELS_PAGE_URL = "https://artificialanalysis.ai/models";
const DEFAULT_OUTPUT_PATH = path.join(rootDir, "public", "data", "models.json");
const rawCachePath = path.join(rootDir, ".cache", "artificial-analysis-llms.json");
const websiteModelsCachePath = path.join(rootDir, ".cache", "artificial-analysis-website-models.json");
const routeConfigPath = path.join(rootDir, "config", "model-routes.json");
const profileConfigPath = path.join(rootDir, "config", "task-profiles.json");

const args = parseArgs(process.argv.slice(2));
const startedAt = Date.now();

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const outputPath = path.resolve(args.output ?? DEFAULT_OUTPUT_PATH);
  const previousPayload = await readOptionalJson(outputPath);
  const [routeConfig, profileConfig, artificialAnalysis] = await Promise.all([
    readJson(routeConfigPath),
    readJson(profileConfigPath),
    getArtificialAnalysisData({ forceRefresh: args.refreshAa, previousPayload })
  ]);
  const websiteModels = await getArtificialAnalysisWebsiteModels({ forceRefresh: args.refreshAa, previousPayload });
  const aaModels = mergeWebsiteModelData(artificialAnalysis.models, websiteModels.models);

  const metricKeys = Array.from(
    new Set(aaModels.flatMap((model) => Object.keys(model.evaluations || {})))
  ).sort();

  const payload = {
    generatedAt: new Date().toISOString(),
    artificialAnalysis: {
      endpoint: AA_URL,
      fetchedAt: artificialAnalysis.fetchedAt,
      source: artificialAnalysis.source,
      warning: artificialAnalysis.warning ?? null,
      modelCount: aaModels.length,
      promptOptions: artificialAnalysis.promptOptions ?? null,
      websiteModels: {
        url: AA_MODELS_PAGE_URL,
        fetchedAt: websiteModels.fetchedAt,
        source: websiteModels.source,
        warning: websiteModels.warning,
        modelCount: websiteModels.models.length
      },
      attribution: "Data from Artificial Analysis: https://artificialanalysis.ai/"
    },
    routeConfig: {
      generatedAt: routeConfig.generatedAt ?? null,
      generatedBy: routeConfig.generatedBy ?? null,
      sources: routeConfig.sources ?? [],
      warnings: routeConfig.warnings ?? []
    },
    profiles: profileConfig.profiles,
    defaultProfileId: profileConfig.defaultProfileId,
    metricKeys,
    variants: mergeVariants(routeConfig, aaModels)
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        generatedAt: payload.generatedAt,
        aaSource: payload.artificialAnalysis.source,
        aaFetchedAt: payload.artificialAnalysis.fetchedAt,
        aaModelCount: payload.artificialAnalysis.modelCount,
        routeGeneratedAt: payload.routeConfig.generatedAt,
        routeSourceCount: payload.routeConfig.sources.length,
        variants: payload.variants.length
      },
      null,
      2
    )
  );
  log(`Done in ${formatDuration(Date.now() - startedAt)}`);
}

async function getArtificialAnalysisData({ forceRefresh, previousPayload }) {
  if (forceRefresh && process.env.ARTIFICIAL_ANALYSIS_API_KEY) {
    try {
      return await fetchArtificialAnalysis();
    } catch (error) {
      if (args.strict) throw error;
      log(`Artificial Analysis refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (forceRefresh) {
    log("Artificial Analysis refresh requested but ARTIFICIAL_ANALYSIS_API_KEY is not set");
  }

  const cached = await readCache();
  if (cached) {
    return {
      fetchedAt: cached.fetchedAt,
      source: forceRefresh ? "stale-cache" : "cache",
      warning: forceRefresh ? "Live Artificial Analysis refresh was unavailable; using local cache." : null,
      promptOptions: cached.payload?.prompt_options ?? null,
      models: normalizeAaPayload(cached.payload)
    };
  }

  if (process.env.ARTIFICIAL_ANALYSIS_API_KEY) {
    try {
      return await fetchArtificialAnalysis();
    } catch (error) {
      if (args.strict) throw error;
      log(`Artificial Analysis live fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const previous = previousArtificialAnalysis(previousPayload);
  if (previous) {
    return previous;
  }

  throw new Error("No Artificial Analysis API key, local cache, or previous static payload is available.");
}

async function fetchArtificialAnalysis() {
  const key = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  if (!key) throw new Error("Missing ARTIFICIAL_ANALYSIS_API_KEY.");
  log("Fetching Artificial Analysis live data");
  const response = await fetch(AA_URL, {
    headers: {
      "x-api-key": key
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Artificial Analysis API returned ${response.status}: ${body.slice(0, 400)}`);
  }

  const payload = await response.json();
  const fetchedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(rawCachePath), { recursive: true });
  await fs.writeFile(rawCachePath, `${JSON.stringify({ fetchedAt, payload }, null, 2)}\n`, "utf8");
  return {
    fetchedAt,
    source: "live",
    warning: null,
    promptOptions: payload?.prompt_options ?? null,
    models: normalizeAaPayload(payload)
  };
}

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(rawCachePath, "utf8"));
  } catch {
    return null;
  }
}

async function getArtificialAnalysisWebsiteModels({ forceRefresh, previousPayload }) {
  if (forceRefresh) {
    try {
      return await fetchArtificialAnalysisWebsiteModels();
    } catch (error) {
      log(`Artificial Analysis website model refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const cached = await readWebsiteModelsCache();
  if (cached) {
    return {
      fetchedAt: cached.fetchedAt,
      source: forceRefresh ? "stale-cache" : "cache",
      warning: forceRefresh ? "Live Artificial Analysis website model refresh was unavailable; using local cache." : null,
      models: normalizeWebsiteModels(cached.models)
    };
  }

  try {
    return await fetchArtificialAnalysisWebsiteModels();
  } catch (error) {
    log(`Artificial Analysis website model fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const previousModels = previousArtificialAnalysisWebsiteModels(previousPayload);
  if (previousModels.length) {
    return {
      fetchedAt: previousPayload.artificialAnalysis?.websiteModels?.fetchedAt ?? previousPayload.generatedAt ?? new Date(0).toISOString(),
      source: "previous-static",
      warning: "Live Artificial Analysis website model data was unavailable; using models embedded in the previous static payload.",
      models: previousModels
    };
  }

  return {
    fetchedAt: null,
    source: "unavailable",
    warning: "Artificial Analysis website model data was unavailable; task cost may fall back to token cost.",
    models: []
  };
}

async function fetchArtificialAnalysisWebsiteModels() {
  log("Fetching Artificial Analysis website model data");
  const response = await fetch(AA_MODELS_PAGE_URL);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Artificial Analysis models page returned ${response.status}: ${body.slice(0, 400)}`);
  }

  const html = await response.text();
  const models = parseArtificialAnalysisWebsiteModels(html);
  const fetchedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(websiteModelsCachePath), { recursive: true });
  await fs.writeFile(websiteModelsCachePath, `${JSON.stringify({ fetchedAt, models }, null, 2)}\n`, "utf8");
  return {
    fetchedAt,
    source: "live",
    warning: null,
    models: normalizeWebsiteModels(models)
  };
}

async function readWebsiteModelsCache() {
  try {
    return JSON.parse(await fs.readFile(websiteModelsCachePath, "utf8"));
  } catch {
    return null;
  }
}

function parseArtificialAnalysisWebsiteModels(html) {
  const flightData = decodeNextFlightData(html);
  const arrays = extractJsonArraysAfterMarker(flightData, '"defaultData":');
  const modelArray = arrays
    .filter((value) => Array.isArray(value))
    .sort((a, b) => scoreWebsiteModelArray(b) - scoreWebsiteModelArray(a))[0];
  return Array.isArray(modelArray) ? modelArray : [];
}

function decodeNextFlightData(html) {
  const scripts = [...html.matchAll(/<script>(self\.__next_f\.push\([\s\S]*?\))<\/script>/g)].map((match) => match[1]);
  const chunks = [];
  const context = {
    self: {
      __next_f: {
        push(value) {
          if (Array.isArray(value) && typeof value[1] === "string") chunks.push(value[1]);
        }
      }
    }
  };

  for (const script of scripts) {
    vm.runInNewContext(script, context, { timeout: 100 });
  }
  return chunks.join("\n");
}

function extractJsonArraysAfterMarker(value, marker) {
  const arrays = [];
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const markerIndex = value.indexOf(marker, searchFrom);
    if (markerIndex === -1) break;
    const start = markerIndex + marker.length;
    const end = findJsonValueEnd(value, start);
    if (end !== -1) {
      try {
        arrays.push(JSON.parse(value.slice(start, end)));
      } catch {
        // Ignore malformed or partial RSC values.
      }
      searchFrom = end;
    } else {
      searchFrom = start;
    }
  }
  return arrays;
}

function findJsonValueEnd(value, start) {
  while (/\s/.test(value[start] ?? "")) start += 1;
  const opener = value[start];
  const closer = opener === "[" ? "]" : opener === "{" ? "}" : null;
  if (!closer) return -1;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function scoreWebsiteModelArray(models) {
  if (!Array.isArray(models)) return 0;
  return models.reduce((score, model) => {
    if (!isPlainObject(model)) return score;
    return (
      score +
      (model.id ? 1 : 0) +
      (model.slug ? 1 : 0) +
      (model.name ? 1 : 0) +
      (model.intelligence_index_cost ? 5 : 0) +
      (model.intelligence_index_token_counts ? 5 : 0)
    );
  }, models.length);
}

function normalizeWebsiteModels(models) {
  return Array.isArray(models) ? models.map(normalizeWebsiteModel).filter(Boolean) : [];
}

function normalizeWebsiteModel(model) {
  if (!isPlainObject(model)) return null;
  return {
    id: cleanText(model.id),
    name: cleanText(model.name),
    slug: cleanText(model.slug),
    intelligenceIndexCost: normalizeIntelligenceIndexCost(model.intelligence_index_cost ?? model.intelligenceIndexCost),
    intelligenceIndexTokenCounts: normalizeIntelligenceIndexTokenCounts(
      model.intelligence_index_token_counts ?? model.intelligenceIndexTokenCounts
    )
  };
}

function previousArtificialAnalysisWebsiteModels(previousPayload) {
  const modelsById = new Map();
  for (const variant of previousPayload?.variants ?? []) {
    const model = variant.model;
    if (
      model?.id &&
      !modelsById.has(model.id) &&
      (model.intelligenceIndexCost || model.intelligenceIndexTokenCounts)
    ) {
      modelsById.set(model.id, {
        id: model.id,
        name: model.name,
        slug: model.slug,
        intelligenceIndexCost: model.intelligenceIndexCost ?? null,
        intelligenceIndexTokenCounts: model.intelligenceIndexTokenCounts ?? null
      });
    }
  }
  return [...modelsById.values()];
}

function mergeWebsiteModelData(models, websiteModels) {
  const lookup = buildWebsiteModelLookup(websiteModels);
  return models.map((model) => {
    const websiteModel = findWebsiteModel(model, lookup);
    if (!websiteModel) return model;
    return {
      ...model,
      intelligenceIndexCost: websiteModel.intelligenceIndexCost ?? model.intelligenceIndexCost ?? null,
      intelligenceIndexTokenCounts: websiteModel.intelligenceIndexTokenCounts ?? model.intelligenceIndexTokenCounts ?? null
    };
  });
}

function buildWebsiteModelLookup(models) {
  const lookup = new Map();
  for (const model of models) {
    for (const key of [model.id, model.slug, model.name].flatMap(candidateKeys)) {
      if (!lookup.has(key)) lookup.set(key, model);
    }
  }
  return lookup;
}

function findWebsiteModel(model, lookup) {
  for (const key of [model.id, model.slug, model.name].flatMap(candidateKeys)) {
    const match = lookup.get(key);
    if (match) return match;
  }
  return null;
}

function previousArtificialAnalysis(previousPayload) {
  const modelsById = new Map();
  for (const variant of previousPayload?.variants ?? []) {
    const model = variant.model;
    if (model?.id && !modelsById.has(model.id)) {
      modelsById.set(model.id, model);
    }
  }

  if (!modelsById.size) return null;
  return {
    fetchedAt: previousPayload.artificialAnalysis?.fetchedAt ?? previousPayload.generatedAt ?? new Date(0).toISOString(),
    source: "previous-static",
    warning: "Live Artificial Analysis data was unavailable; using models embedded in the previous static payload.",
    promptOptions: previousPayload.artificialAnalysis?.promptOptions ?? null,
    models: [...modelsById.values()]
  };
}

function normalizeAaPayload(payload) {
  return Array.isArray(payload?.data) ? payload.data.map(normalizeAaModel) : [];
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeIntelligenceIndexCost(value) {
  if (!isPlainObject(value)) return null;
  return {
    total: numberOrNull(value.total_cost ?? value.total),
    input: numberOrNull(value.input_cost ?? value.input),
    output: numberOrNull(value.output_cost ?? value.output),
    reasoning: numberOrNull(value.reasoning_cost ?? value.reasoning),
    answer: numberOrNull(value.answer_cost ?? value.answer)
  };
}

function normalizeIntelligenceIndexTokenCounts(value) {
  if (!isPlainObject(value)) return null;
  return {
    input: numberOrNull(value.input_tokens ?? value.input),
    output: numberOrNull(value.output_tokens ?? value.output),
    reasoning: numberOrNull(value.reasoning_tokens ?? value.reasoning),
    answer: numberOrNull(value.answer_tokens ?? value.answer)
  };
}

function normalizeAaModel(model) {
  const pricing = model.pricing || {};
  return {
    id: model.id,
    name: model.name,
    slug: model.slug,
    releaseDate: model.release_date ?? null,
    creator: model.model_creator?.name ?? "Unknown",
    creatorSlug: model.model_creator?.slug ?? null,
    evaluations: model.evaluations || {},
    basePricing: {
      blended3To1: numberOrNull(pricing.price_1m_blended_3_to_1),
      blended7To2To1: numberOrNull(pricing.price_1m_blended_7_to_2_to_1),
      input: numberOrNull(pricing.price_1m_input_tokens),
      output: numberOrNull(pricing.price_1m_output_tokens)
    },
    performance: {
      outputTokensPerSecond: numberOrNull(model.median_output_tokens_per_second),
      timeToFirstTokenSeconds: numberOrNull(model.median_time_to_first_token_seconds),
      timeToFirstAnswerTokenSeconds: numberOrNull(model.median_time_to_first_answer_token)
    },
    intelligenceIndexCost: normalizeIntelligenceIndexCost(model.intelligence_index_cost ?? pricing.intelligence_index_cost),
    intelligenceIndexTokenCounts: normalizeIntelligenceIndexTokenCounts(model.intelligence_index_token_counts)
  };
}

function buildModelLookup(models) {
  const lookup = new Map();
  for (const model of models) {
    for (const key of modelLookupKeys(model)) {
      const existing = lookup.get(key) ?? [];
      existing.push(model);
      lookup.set(key, existing);
    }
  }
  return lookup;
}

function modelLookupKeys(model) {
  return [model.id, model.slug, model.name].flatMap(candidateKeys);
}

function getPricing(route, aaModel, cachedInputMultiplier) {
  const input = numberOrNull(route.pricing?.input) ?? aaModel?.basePricing.input ?? null;
  const output = numberOrNull(route.pricing?.output) ?? aaModel?.basePricing.output ?? null;
  const cachedInput =
    numberOrNull(route.pricing?.cachedInput) ??
    (input === null ? null : Number((input * cachedInputMultiplier).toFixed(6)));

  return {
    input,
    cachedInput,
    output,
    cacheWrite: numberOrNull(route.pricing?.cacheWrite),
    cacheWrite1h: numberOrNull(route.pricing?.cacheWrite1h),
    unit: route.pricing?.unit ?? "usd_per_1m_tokens",
    source: route.pricing?.source ?? "Artificial Analysis baseline"
  };
}

function mergeVariants(routeConfig, aaModels) {
  const lookup = buildModelLookup(aaModels);
  const cachedInputMultiplier = routeConfig.defaults?.cachedInputMultiplier ?? 0.1;

  return routeConfig.variants.flatMap((route) => {
    const aaModels = findAaModels(route, lookup);
    if (!aaModels.length) return [buildVariant(route, null, cachedInputMultiplier, false)];
    return aaModels.map((aaModel) => buildVariant(route, aaModel, cachedInputMultiplier, aaModels.length > 1));
  });
}

function buildVariant(route, aaModel, cachedInputMultiplier, hasBenchmarkSiblings) {
    const speedMultiplier = Number(route.options?.speedMultiplier ?? 1);
    const baseSpeed = aaModel?.performance.outputTokensPerSecond ?? null;
    const benchmarkOptions = aaModel ? benchmarkOptionsFromName(aaModel.name) : {};
    const benchmarkSuffix = aaModel ? benchmarkVariantSuffix(aaModel.name) : "";

    return {
      ...route,
      id: hasBenchmarkSiblings && aaModel ? `${route.id}-${slugify(aaModel.slug || aaModel.id || aaModel.name)}` : route.id,
      label: hasBenchmarkSiblings && aaModel ? aaModel.name : route.label,
      aaMatched: Boolean(aaModel),
      model: aaModel,
      options: {
        ...(route.options ?? {}),
        ...benchmarkOptions
      },
      pricing: getPricing(route, aaModel, cachedInputMultiplier),
      metadata: {
        ...(route.metadata ?? {}),
        benchmarkVariant: benchmarkSuffix || null
      },
      effectivePerformance: {
        outputTokensPerSecond:
          baseSpeed === null ? null : Number((baseSpeed * speedMultiplier).toFixed(3)),
        baseOutputTokensPerSecond: baseSpeed,
        speedMultiplier
      }
    };
}

function findAaModels(route, lookup) {
  const lookupKeys = [route.modelId, route.modelSlug, route.modelName, route.label]
    .flatMap(candidateKeys)
    .filter(Boolean);
  for (const key of lookupKeys) {
    const matches = lookup.get(key);
    if (matches?.length) return sortAaModels(matches, key);
  }
  return [];
}

function sortAaModels(models, lookupKey) {
  return uniqueModels(models).sort((a, b) => modelScore(b, lookupKey) - modelScore(a, lookupKey));
}

function uniqueModels(models) {
  const byId = new Map();
  for (const model of models) {
    if (model?.id && !byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()];
}

function modelScore(model, lookupKey) {
  const intelligence = model.evaluations?.artificial_analysis_intelligence_index;
  let score = typeof intelligence === "number" && Number.isFinite(intelligence) ? 100 : 0;
  if ([model.id, model.slug, model.name].map(canonicalKey).includes(lookupKey)) score += 25;
  if (/realtime|audio|image|preview image/i.test(model.name)) score -= 50;
  if (/chatgpt/i.test(model.name)) score -= 10;
  return score;
}

function benchmarkVariantSuffix(name) {
  const match = cleanText(name).match(/\(([^)]+)\)/);
  return match?.[1] ?? "";
}

function benchmarkOptionsFromName(name) {
  const suffix = benchmarkVariantSuffix(name).toLowerCase();
  if (!suffix) return {};

  const options = {};
  if (suffix.includes("adaptive reasoning")) options.reasoning = "adaptive reasoning";
  else if (suffix.includes("non-reasoning")) options.reasoning = "non-reasoning";
  else if (suffix.includes("reasoning")) options.reasoning = "reasoning";

  if (suffix.includes("max effort")) options.effort = "max";
  else if (suffix.includes("high effort")) options.effort = "high";
  else if (suffix.includes("medium effort")) options.effort = "medium";
  else if (suffix.includes("low effort")) options.effort = "low";

  return options;
}

function candidateKeys(value) {
  const text = cleanText(value);
  if (!text) return [];
  const noParens = text.replace(/\([^)]*\)/g, " ");
  const keys = [
    canonicalKey(text),
    canonicalKey(noParens),
    ...orderInvariantAliases(text),
    ...orderInvariantAliases(noParens),
    ...semanticAliases(text),
    ...semanticAliases(noParens),
    text.toLowerCase()
  ];
  return uniqueOrdered(keys.filter(Boolean));
}

function semanticAliases(value) {
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

function orderInvariantAliases(value) {
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

function normalizeVersionTokens(tokens) {
  const normalized = [];
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

function canonicalKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function slugify(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueOrdered(values) {
  return [...new Set(values.filter(Boolean))];
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const parsed = {
    output: null,
    refreshAa: false,
    strict: false,
    quiet: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--refresh-aa") parsed.refreshAa = true;
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "--quiet") parsed.quiet = true;
    else if (arg === "--output") parsed.output = argv[++index];
    else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/build-static-data.mjs [--refresh-aa] [--strict] [--quiet] [--output PATH]

Builds the checked-in static payload used by the GitHub Pages app.

Options:
  --refresh-aa      Try to refresh Artificial Analysis with ARTIFICIAL_ANALYSIS_API_KEY.
  --strict          Fail instead of falling back when live Artificial Analysis refresh fails.
  --output PATH     Write to a custom output path. Default: public/data/models.json.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function log(message) {
  if (args.quiet) return;
  const elapsed = formatDuration(Date.now() - startedAt).padStart(6, " ");
  console.error(`[${elapsed}] ${message}`);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
