import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env"), quiet: true });
dotenv.config({ path: path.join(rootDir, ".env.local"), override: true, quiet: true });

const AA_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
const defaultAaCachePath = path.join(rootDir, ".cache", "artificial-analysis-llms.json");
const staticPayloadPath = path.join(rootDir, "public", "data", "models.json");
const args = parseArgs(process.argv.slice(2));
const startedAt = Date.now();

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  if (!args.url) {
    throw new Error("Missing --url. Point it at a LiteLLM /model_group/info, /model/info, or /models endpoint.");
  }

  log(`Fetching ${args.url}`);
  const [payload, aaModels] = await Promise.all([
    fetchJson(args.url),
    loadArtificialAnalysisModels()
  ]);
  const aaLookup = buildAaLookup(aaModels);
  const models = normalizeModels(payload)
    .map((model) => attachBenchmarks(model, aaLookup))
    .filter((model) => matchesFilter(model.label))
    .sort((a, b) => [a.providerHint ?? "", a.label].join("|").localeCompare([b.providerHint ?? "", b.label].join("|")));
  const benchmarked = models.filter((model) => model.benchmarks?.length || model.benchmark).length;

  const overlay = {
    version: 1,
    kind: "model-route-overlay",
    name: args.name,
    provider: args.provider,
    fetchedAt: new Date().toISOString(),
    pricingMode: "public-match",
    models
  };

  const outputPath = path.resolve(args.output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        provider: overlay.provider,
        models: overlay.models.length,
        benchmarked,
        missingBenchmarks: overlay.models.length - benchmarked,
        elapsed: formatDuration(Date.now() - startedAt)
      },
      null,
      2
    )
  );
}

async function fetchJson(url) {
  const headers = {
    Accept: "application/json"
  };
  if (process.env.LITELLM_BEARER_TOKEN) headers.Authorization = `Bearer ${process.env.LITELLM_BEARER_TOKEN}`;
  if (process.env.LITELLM_API_KEY) headers["x-api-key"] = process.env.LITELLM_API_KEY;
  if (process.env.LITELLM_COOKIE) headers.Cookie = process.env.LITELLM_COOKIE;

  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
  }
  if (/^\s*</.test(text)) {
    throw new Error("Expected JSON but received HTML. Check authentication and endpoint URL.");
  }
  return JSON.parse(text);
}

async function loadArtificialAnalysisModels() {
  if (args.refreshAa && process.env.ARTIFICIAL_ANALYSIS_API_KEY) {
    try {
      log("Fetching Artificial Analysis live data");
      const response = await fetch(AA_URL, {
        headers: {
          "x-api-key": process.env.ARTIFICIAL_ANALYSIS_API_KEY
        }
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
      const payload = JSON.parse(text);
      await fs.mkdir(path.dirname(args.aaCache), { recursive: true });
      await fs.writeFile(args.aaCache, `${JSON.stringify({ fetchedAt: new Date().toISOString(), payload }, null, 2)}\n`, "utf8");
      return normalizeAaPayload(payload);
    } catch (error) {
      if (args.strictAa) throw error;
      log(`Artificial Analysis live fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const cached = await readOptionalJson(args.aaCache);
  if (cached?.payload) {
    log(`Using Artificial Analysis cache at ${args.aaCache}`);
    return normalizeAaPayload(cached.payload);
  }

  if (process.env.ARTIFICIAL_ANALYSIS_API_KEY) {
    try {
      log("Fetching Artificial Analysis live data");
      const response = await fetch(AA_URL, {
        headers: {
          "x-api-key": process.env.ARTIFICIAL_ANALYSIS_API_KEY
        }
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
      return normalizeAaPayload(JSON.parse(text));
    } catch (error) {
      if (args.strictAa) throw error;
      log(`Artificial Analysis live fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const staticPayload = await readOptionalJson(staticPayloadPath);
  const staticModels = previousArtificialAnalysisModels(staticPayload);
  if (staticModels.length) {
    log("Using Artificial Analysis models embedded in public/data/models.json");
    return staticModels;
  }

  if (args.strictAa) {
    throw new Error("No Artificial Analysis data found. Set ARTIFICIAL_ANALYSIS_API_KEY or provide --aa-cache.");
  }
  log("No Artificial Analysis data found; exported overlay will not include benchmarks.");
  return [];
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeAaPayload(payload) {
  return Array.isArray(payload?.data) ? payload.data.map(normalizeAaModel) : [];
}

function previousArtificialAnalysisModels(payload) {
  const modelsById = new Map();
  for (const variant of payload?.variants ?? []) {
    if (variant.model?.id && !modelsById.has(variant.model.id)) {
      modelsById.set(variant.model.id, variant.model);
    }
  }
  return [...modelsById.values()];
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
    intelligenceIndexCost: normalizeIntelligenceIndexCost(model.intelligence_index_cost ?? pricing.intelligence_index_cost ?? model.intelligenceIndexCost),
    intelligenceIndexTokenCounts: normalizeIntelligenceIndexTokenCounts(
      model.intelligence_index_token_counts ?? model.intelligenceIndexTokenCounts
    )
  };
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildAaLookup(models) {
  const lookup = new Map();
  for (const model of models) {
    for (const key of [model.id, model.slug, model.name].flatMap(candidateKeys)) {
      const existing = lookup.get(key) ?? [];
      existing.push(model);
      lookup.set(key, existing);
    }
  }
  return lookup;
}

function attachBenchmarks(model, aaLookup) {
  const benchmarks = findBenchmarks(model, aaLookup);
  return benchmarks.length ? { ...model, benchmark: benchmarks[0], benchmarks } : model;
}

function findBenchmarks(model, aaLookup) {
  const keys = [model.id, model.label, model.model, ...(model.aliases ?? [])]
    .flatMap((value) => [value, stripProviderPrefix(value)])
    .flatMap(candidateKeys);
  for (const key of keys) {
    const matches = aaLookup.get(key);
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

function normalizeModels(payload) {
  const rows = flattenPayload(payload);
  const byKey = new Map();

  for (const row of rows) {
    const label = cleanModelName(
      row.model_group ||
        row.model_name ||
        row.name ||
        row.id ||
        row.model_info?.base_model ||
        row.litellm_params?.model ||
        row.model
    );
    if (!label) continue;

    const providerHint = cleanProviderName(
      Array.isArray(row.providers) ? row.providers[0] : null,
      row.provider,
      row.litellm_provider,
      row.owned_by,
      row.model_info?.provider,
      row.model_info?.litellm_provider,
      row.litellm_params?.litellm_provider,
      modelPrefix(row.model || row.litellm_params?.model)
    );
    const key = `${canonicalKey(providerHint)}|${canonicalKey(label)}`;
    if (byKey.has(key)) continue;

    byKey.set(key, pruneNullish({
      id: slugify(`${providerHint || "model"}-${label}`),
      label,
      model: cleanModelName(row.model_info?.base_model || stripProviderPrefix(row.model || row.litellm_params?.model) || label),
      providerHint,
      aliases: uniqueSorted([
        row.model,
        row.model_name,
        row.model_group,
        row.name,
        row.model_info?.base_model,
        stripProviderPrefix(row.litellm_params?.model)
      ].map(cleanModelName)),
      contextWindow: numberOrNull(row.max_input_tokens ?? row.model_info?.max_input_tokens ?? row.metadata?.maxInputTokens),
      maxOutputTokens: numberOrNull(row.max_output_tokens ?? row.model_info?.max_output_tokens ?? row.metadata?.maxOutputTokens),
      limits: pruneNullish({
        rpm: numberOrNull(row.rpm ?? row.model_info?.rpm),
        tpm: numberOrNull(row.tpm ?? row.model_info?.tpm),
        maxParallelRequests: numberOrNull(row.max_parallel_requests ?? row.model_info?.max_parallel_requests),
        budget: numberOrNull(row.budget ?? row.model_info?.budget)
      })
    }));
  }

  return [...byKey.values()];
}

function flattenPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  if (payload?.models && typeof payload.models === "object") {
    return Object.entries(payload.models).map(([id, value]) =>
      value && typeof value === "object" ? { id, ...value } : { id, value }
    );
  }
  if (payload && typeof payload === "object") {
    return Object.entries(payload).map(([id, value]) =>
      value && typeof value === "object" ? { id, ...value } : { id, value }
    );
  }
  return [];
}

function cleanProviderName(...values) {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  if (!value) return null;
  return String(value).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function modelPrefix(value) {
  if (typeof value !== "string" || !value.includes("/")) return null;
  return value.split("/")[0];
}

function stripProviderPrefix(value) {
  if (typeof value !== "string") return "";
  return value.includes("/") ? value.split("/").slice(1).join("/") : value;
}

function cleanModelName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function matchesFilter(label) {
  if (args.filter && !args.filter.test(label)) return false;
  if (args.exclude && args.exclude.test(label)) return false;
  return true;
}

function canonicalKey(value) {
  return cleanModelName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function candidateKeys(value) {
  const text = cleanModelName(value);
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

function slugify(value) {
  return cleanModelName(value)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function numberOrNull(value) {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function uniqueOrdered(values) {
  return [...new Set(values.filter(Boolean))];
}

function pruneNullish(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === null || entry === undefined || entry === "") return false;
      if (Array.isArray(entry) && entry.length === 0) return false;
      if (typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length === 0) return false;
      return true;
    })
  );
}

function parseArgs(argv) {
  const parsed = {
    url: "",
    output: path.join(rootDir, "local", "provider-overlay.json"),
    name: "Imported provider",
    provider: "Imported Provider",
    aaCache: defaultAaCachePath,
    refreshAa: false,
    strictAa: false,
    filter: null,
    exclude: null,
    quiet: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") parsed.url = argv[++index];
    else if (arg.startsWith("--url=")) parsed.url = arg.slice("--url=".length);
    else if (arg === "--output") parsed.output = argv[++index];
    else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length);
    else if (arg === "--name") parsed.name = argv[++index];
    else if (arg.startsWith("--name=")) parsed.name = arg.slice("--name=".length);
    else if (arg === "--provider") parsed.provider = argv[++index];
    else if (arg.startsWith("--provider=")) parsed.provider = arg.slice("--provider=".length);
    else if (arg === "--aa-cache") parsed.aaCache = path.resolve(argv[++index]);
    else if (arg.startsWith("--aa-cache=")) parsed.aaCache = path.resolve(arg.slice("--aa-cache=".length));
    else if (arg === "--refresh-aa") parsed.refreshAa = true;
    else if (arg === "--strict-aa") parsed.strictAa = true;
    else if (arg === "--filter") parsed.filter = new RegExp(argv[++index], "i");
    else if (arg.startsWith("--filter=")) parsed.filter = new RegExp(arg.slice("--filter=".length), "i");
    else if (arg === "--exclude") parsed.exclude = new RegExp(argv[++index], "i");
    else if (arg.startsWith("--exclude=")) parsed.exclude = new RegExp(arg.slice("--exclude=".length), "i");
    else if (arg === "--quiet") parsed.quiet = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/export-litellm-overlay.mjs --url URL [--provider NAME] [--output PATH]

Exports a browser-importable model availability overlay from a LiteLLM-style endpoint.
The overlay contains model names, limits, and Artificial Analysis benchmark matches when available.

Options:
  --url URL          LiteLLM /model_group/info, /model/info, /models, or compatible JSON endpoint.
  --provider NAME    Display provider name for imported routes. Default: "Imported Provider".
  --name NAME        Overlay label. Default: "Imported provider".
  --output PATH      Output JSON path. Default: local/provider-overlay.json.
  --aa-cache PATH    Artificial Analysis cache path. Default: .cache/artificial-analysis-llms.json.
  --refresh-aa       Fetch fresh Artificial Analysis data when ARTIFICIAL_ANALYSIS_API_KEY is set.
  --strict-aa        Fail when Artificial Analysis data is unavailable.
  --filter REGEX     Include matching model labels only.
  --exclude REGEX    Exclude matching model labels.

Environment:
  LITELLM_BEARER_TOKEN   Optional Bearer token.
  LITELLM_API_KEY        Optional x-api-key.
  LITELLM_COOKIE         Optional Cookie header.
  ARTIFICIAL_ANALYSIS_API_KEY   Optional key for fresh AA benchmark matching.
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
  console.error(`[${formatDuration(Date.now() - startedAt)}] ${message}`);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
