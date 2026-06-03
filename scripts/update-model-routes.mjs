import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dotenv from "dotenv";
import YAML from "yaml";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env"), quiet: true });
dotenv.config({ path: path.join(rootDir, ".env.local"), override: true, quiet: true });

const DEFAULT_OUTPUT_PATH = path.join(rootDir, "config", "model-routes.json");
const GITHUB_MODELS_CATALOG_URL = "https://models.github.ai/catalog/models";
const GITHUB_COPILOT_PRICING_URL =
  "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml";
const CLAUDE_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";
const CODEX_RATE_CARD_URL = "https://help.openai.com/en/articles/20001106-codex-rate-card";
const CODEX_CREDIT_VALUE_URL =
  "https://help.openai.com/en/articles/20001147-codex-credits-for-students-terms-of-service";
const AZURE_RETAIL_PRICES_URL = "https://prices.azure.com/api/retail/prices";

const args = parseArgs(process.argv.slice(2));
const generatedAt = new Date().toISOString();
const startedAt = Date.now();
const sourceReports = [];
const warnings = [];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const outputPath = path.resolve(args.output ?? DEFAULT_OUTPUT_PATH);
  log(`Updating model routes -> ${args.dryRun ? "stdout" : outputPath}`);
  const previousRouteConfig = args.dryRun ? null : await readOptionalJson(outputPath);
  const sources = await loadAllSources();
  log("Building normalized route variants");
  const variants = buildVariantsWithPreservation(sources, previousRouteConfig);

  const payload = {
    version: 1,
    generatedAt,
    generatedBy: "scripts/update-model-routes.mjs",
    defaults: {
      cachedInputMultiplier: 0.1
    },
    sources: sortSourceReports(sourceReports),
    warnings,
    variants: sortVariants(dedupeVariants(variants))
  };

  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (args.dryRun) {
    console.log(body);
  } else {
    log(`Writing ${payload.variants.length} variants to ${outputPath}`);
    await fs.writeFile(outputPath, body, "utf8");
    console.log(
      JSON.stringify(
        {
          output: outputPath,
          variants: payload.variants.length,
          sources: sourceReports.map((source) => ({
            id: source.id,
            status: source.status,
            count: source.count ?? null
          })),
          warnings
        },
        null,
        2
      )
    );
  }
  log(`Done in ${formatDuration(Date.now() - startedAt)}`);
}

async function loadAllSources() {
  const [githubCatalog, githubPricing, claudePricing, codexPricing, codexCreditValue, azureMeters] =
    await Promise.all([
      withSource("github-models-catalog", GITHUB_MODELS_CATALOG_URL, fetchGithubCatalog),
      withSource("github-copilot-pricing", GITHUB_COPILOT_PRICING_URL, fetchGithubCopilotPricing),
      withSource("claude-pricing", CLAUDE_PRICING_URL, fetchClaudePricing),
      withSource("codex-rate-card", CODEX_RATE_CARD_URL, fetchCodexPricing),
      withSource("codex-credit-value", CODEX_CREDIT_VALUE_URL, fetchCodexCreditValue),
      withSource("azure-foundry-global-standard", AZURE_RETAIL_PRICES_URL, fetchAzureFoundryMeters)
    ]);

  return {
    githubCatalog,
    githubPricing,
    claudePricing,
    codexPricing,
    codexCreditValue,
    azureMeters
  };
}

function buildVariantsWithPreservation(sources, previousRouteConfig) {
  const groups = [
    {
      id: "github-copilot-pricing",
      label: "GitHub Copilot",
      sourceIds: ["github-copilot-pricing"],
      variants: buildGithubCopilotVariants(sources.githubPricing ?? [], sources.githubCatalog ?? []),
      preserve: (variant) => variant.route === "github-copilot"
    },
    {
      id: "claude-pricing",
      label: "Claude pricing",
      sourceIds: ["claude-pricing"],
      variants: buildClaudeVariants(sources.claudePricing ?? []),
      preserve: (variant) => variant.route === "anthropic-api"
    },
    {
      id: "codex-rate-card",
      label: "Codex rate card",
      sourceIds: ["codex-rate-card", "codex-credit-value"],
      variants: buildCodexVariants(sources.codexPricing ?? [], sources.codexCreditValue),
      preserve: (variant) => variant.route === "codex-flexible-pricing" || variant.provider === "Codex"
    },
    {
      id: "azure-foundry-global-standard",
      label: "Azure Foundry Global Standard",
      sourceIds: ["azure-foundry-global-standard"],
      variants: buildAzureVariants(sources.azureMeters ?? []),
      preserve: (variant) => variant.route === "azure-foundry-global-standard"
    }
  ];

  return groups.flatMap((group) => {
    const failed = group.sourceIds.some((sourceId) => sourceStatus(sourceId) === "error");
    if (group.variants.length > 0 || !failed) return group.variants;
    return preserveExistingVariants(group, previousRouteConfig);
  });
}

function sourceStatus(id) {
  return sourceReports.find((source) => source.id === id)?.status ?? "missing";
}

function preserveExistingVariants(group, previousRouteConfig) {
  const preserved = (previousRouteConfig?.variants ?? []).filter(group.preserve);
  if (!preserved.length) {
    warnings.push(`${group.id}: no existing ${group.label} variants were available to preserve after refresh failed.`);
    log(`${group.label}: no existing variants to preserve`);
    return [];
  }

  const reason = `${group.sourceIds.join(", ")} could not be refreshed`;
  warnings.push(`${group.id}: preserved ${preserved.length} existing ${group.label} variants because ${reason}.`);
  log(`${group.label}: preserved ${preserved.length} existing variants because ${reason}`);

  return preserved.map((variant) => ({
    ...variant,
    metadata: pruneNullish({
      ...(variant.metadata ?? {}),
      preservedFromPriorRun: true,
      preservedAt: generatedAt,
      preservationReason: reason
    })
  }));
}

async function withSource(id, url, loader) {
  const sourceStartedAt = Date.now();
  log(`Starting ${id}`);
  try {
    const data = await loader();
    const durationMs = Date.now() - sourceStartedAt;
    sourceReports.push({
      id,
      url,
      fetchedAt: new Date().toISOString(),
      status: "ok",
      count: Array.isArray(data) ? data.length : null,
      durationMs
    });
    log(`Finished ${id}: ${Array.isArray(data) ? data.length : "n/a"} records in ${formatDuration(durationMs)}`);
    return data;
  } catch (error) {
    const durationMs = Date.now() - sourceStartedAt;
    const message = error instanceof Error ? error.message : String(error);
    const warning = `${id}: ${message}`;
    warnings.push(warning);
    sourceReports.push({
      id,
      url,
      fetchedAt: new Date().toISOString(),
      status: "error",
      warning,
      durationMs
    });
    log(`Failed ${id} after ${formatDuration(durationMs)}: ${message}`);
    if (args.strict) throw new Error(warning);
    return [];
  }
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function fetchGithubCatalog() {
  const baseHeaders = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10"
  };
  const githubAuth = await getGithubAuth();
  const attempts = githubAuth
    ? [
        { ...baseHeaders, Authorization: `Bearer ${githubAuth.token}` },
        { ...baseHeaders, Authorization: `token ${githubAuth.token}` },
        baseHeaders
      ]
    : [baseHeaders];
  if (githubAuth) log(`GitHub catalog using token from ${githubAuth.source}`);

  let lastError = null;
  let json = null;
  for (const [index, headers] of attempts.entries()) {
    const authMode = headers.Authorization ? headers.Authorization.split(" ")[0] : "none";
    log(`GitHub catalog attempt ${index + 1}/${attempts.length} using auth=${authMode}`);
    try {
      json = await fetchJson(GITHUB_MODELS_CATALOG_URL, {
        headers,
        label: `GitHub Models Catalog auth=${authMode}`
      });
      break;
    } catch (error) {
      lastError = error;
      log(`GitHub catalog auth=${authMode} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!json) throw lastError;
  if (!Array.isArray(json)) {
    throw new Error("Expected the GitHub Models Catalog API to return an array.");
  }
  return json;
}

async function fetchGithubCopilotPricing() {
  const text = await fetchText(GITHUB_COPILOT_PRICING_URL, {
    headers: githubHeaders(),
    label: "GitHub Copilot pricing YAML"
  });
  const rows = YAML.parse(text);
  if (!Array.isArray(rows)) {
    throw new Error("Expected GitHub Copilot pricing YAML to contain an array.");
  }
  return rows;
}

async function fetchClaudePricing() {
  const text = await fetchText(CLAUDE_PRICING_URL, { label: "Claude pricing markdown" });
  const table = parseMarkdownTable(text, ["Model", "Base Input Tokens", "Cache Hits & Refreshes"]);
  return table
    .map((row) => ({
      model: stripMarkdown(row.Model),
      input: parseMoneyPerMillion(row["Base Input Tokens"]),
      cachedInput: parseMoneyPerMillion(row["Cache Hits & Refreshes"]),
      output: parseMoneyPerMillion(row["Output Tokens"]),
      cacheWrite5m: parseMoneyPerMillion(row["5m Cache Writes"]),
      cacheWrite1h: parseMoneyPerMillion(row["1h Cache Writes"])
    }))
    .filter((row) => row.model && row.input !== null && row.output !== null)
    .filter((row) => args.includeDeprecated || !/(deprecated|retired)/i.test(row.model));
}

async function fetchCodexPricing() {
  log("Launching headless browser for Codex rate card");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
    });
    log("Loading Codex rate-card page");
    await page.goto(CODEX_RATE_CARD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("table", { timeout: 20_000 });
    log("Extracting Codex rate-card tables from browser DOM");
    const tables = await page.evaluate(() =>
      [...document.querySelectorAll("table")].map((table) =>
        [...table.rows].map((row) => [...row.cells].map((cell) => cell.innerText.trim()))
      )
    );
    const tokenTable = tables.find((table) => {
      const header = table[0] ?? [];
      return (
        header.includes("Model") &&
        header.includes("Input tokens") &&
        header.includes("Cached input tokens") &&
        header.includes("Output tokens")
      );
    });
    if (!tokenTable) {
      throw new Error("Could not find the token-based Codex rate-card table.");
    }

    const [header, ...rows] = tokenTable;
    return rows
      .map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""])))
      .map((row) => ({
        model: row.Model,
        input: parseCredits(row["Input tokens"]),
        cachedInput: parseCredits(row["Cached input tokens"]),
        output: parseCredits(row["Output tokens"])
      }))
      .filter((row) => row.model && row.input !== null && row.output !== null)
      .filter((row) => !/(image|research preview)/i.test(row.model));
  } finally {
    await browser.close();
  }
}

async function fetchCodexCreditValue() {
  log("Launching headless browser for Codex credit value");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
    });
    log("Loading Codex credit-value page");
    await page.goto(CODEX_CREDIT_VALUE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText);
    const match = text.match(/(\d[\d,]*)\s+credits,?\s+which\s+is\s+equivalent\s+to\s+\$(\d+(?:\.\d+)?)/i);
    if (!match) {
      throw new Error("Could not find a credits-to-dollar equivalence statement.");
    }

    const credits = Number(match[1].replace(/,/g, ""));
    const dollars = Number(match[2]);
    if (!Number.isFinite(credits) || !Number.isFinite(dollars) || credits <= 0 || dollars <= 0) {
      throw new Error(`Invalid credits-to-dollar values: ${match[0]}`);
    }

    const creditsPerDollar = credits / dollars;
    log(`Codex credit conversion: ${credits} credits = $${dollars} (${creditsPerDollar} credits/$)`);
    return {
      credits,
      dollars,
      creditsPerDollar,
      dollarsPerCredit: dollars / credits
    };
  } finally {
    await browser.close();
  }
}

async function fetchAzureFoundryMeters() {
  const items = [];
  const firstUrl = new URL(AZURE_RETAIL_PRICES_URL);
  firstUrl.searchParams.set("api-version", "2023-01-01-preview");
  firstUrl.searchParams.set(
    "$filter",
    "serviceName eq 'Foundry Models' and priceType eq 'Consumption'"
  );

  let nextUrl = firstUrl.toString();
  let page = 1;
  while (nextUrl) {
    const json = await fetchJson(nextUrl, { label: `Azure Retail Prices page ${page}` });
    const pageItems = json.Items ?? [];
    items.push(...pageItems);
    log(`Azure Retail Prices page ${page}: +${pageItems.length} records, total ${items.length}`);
    nextUrl = json.NextPageLink || "";
    page += 1;
  }

  const filtered = items.filter(isAzureGlobalStandardPaygTokenMeter);
  log(`Azure filter kept ${filtered.length} Global Standard PAYG token meters from ${items.length} retail records`);
  return filtered;
}

function buildGithubCopilotVariants(rows, catalog) {
  const catalogByName = buildCatalogIndex(catalog);
  return rows
    .map((row) => {
      const model = cleanModelName(row.model);
      const catalogModel = catalogByName.get(canonicalKey(model)) ?? null;
      return createVariant({
        sourceKey: `github-copilot-${row.provider}-${model}`,
        label: model,
        modelSlug: slugify(catalogModel?.id ?? model),
        provider: "GitHub Copilot",
        route: "github-copilot",
        taskTags: compact([
          "copilot",
          "coding",
          row.provider,
          row.category && slugify(row.category),
          catalogModel?.registry,
          ...(catalogModel?.capabilities ?? [])
        ]),
        options: {
          reasoning: reasoningFor(model, catalogModel?.capabilities),
          effort: effortFor(row.category),
          speed: "subscription",
          speedMultiplier: 1
        },
        pricing: {
          input: parseMoney(row.input),
          cachedInput: parseMoney(row.cached_input),
          output: parseMoney(row.output),
          cacheWrite: parseMoney(row.cache_write),
          unit: "usd_per_1m_tokens",
          source: "GitHub docs models-and-pricing.yml, enriched with GitHub Models Catalog API when matched."
        },
        metadata: {
          releaseStatus: row.release_status ?? null,
          category: row.category ?? null,
          githubModelsCatalogId: catalogModel?.id ?? null,
          githubModelsCatalogUrl: catalogModel?.html_url ?? null,
          contextWindow: catalogModel?.limits?.max_input_tokens ?? null,
          maxOutputTokens: catalogModel?.limits?.max_output_tokens ?? null
        }
      });
    })
    .filter(hasUsablePricing);
}

function buildClaudeVariants(rows) {
  return rows.map((row) =>
    createVariant({
      sourceKey: `anthropic-${row.model}`,
      label: row.model,
      modelSlug: slugify(row.model),
      provider: "Anthropic",
      route: "anthropic-api",
      taskTags: compact(["claude", "anthropic", "api", familyTag(row.model)]),
      options: {
        reasoning: reasoningFor(row.model),
        effort: effortFor(row.model),
        speed: "standard",
        speedMultiplier: 1
      },
      pricing: {
        input: row.input,
        cachedInput: row.cachedInput,
        output: row.output,
        cacheWrite: row.cacheWrite5m,
        cacheWrite1h: row.cacheWrite1h,
        unit: "usd_per_1m_tokens",
        source: "Anthropic Claude pricing markdown table."
      }
    })
  );
}

function buildCodexVariants(rows, creditValue) {
  if (!creditValue?.creditsPerDollar) {
    warnings.push("codex-rate-card: skipped Codex variants because the credit-to-dollar conversion source was unavailable.");
    return [];
  }

  return rows.map((row) =>
    createVariant({
      sourceKey: `codex-${row.model}`,
      label: row.model,
      modelSlug: slugify(row.model),
      provider: "Codex",
      route: "codex-flexible-pricing",
      taskTags: compact(["codex", "coding", "agent", familyTag(row.model)]),
      options: {
        reasoning: reasoningFor(row.model),
        effort: effortFor(row.model),
        speed: "standard",
        speedMultiplier: 1
      },
      pricing: {
        input: creditsToDollars(row.input, creditValue),
        cachedInput: creditsToDollars(row.cachedInput, creditValue),
        output: creditsToDollars(row.output, creditValue),
        unit: "usd_per_1m_tokens",
        source: `OpenAI Help Center Codex rate card converted from credits to USD using ${creditValue.credits} credits = $${creditValue.dollars}.`
      },
      metadata: {
        originalCreditRates: {
          input: row.input,
          cachedInput: row.cachedInput,
          output: row.output,
          unit: "credits_per_1m_tokens"
        },
        creditConversion: {
          credits: creditValue.credits,
          dollars: creditValue.dollars,
          creditsPerDollar: creditValue.creditsPerDollar,
          dollarsPerCredit: creditValue.dollarsPerCredit
        }
      }
    })
  );
}

function buildAzureVariants(meters) {
  const perRegion = new Map();
  for (const meter of meters) {
    const modelName = cleanAzureModelName(meter);
    if (!modelName) continue;
    const tokenKind = azureTokenKind(meter);
    if (!tokenKind) continue;
    const price = azurePricePerMillion(meter);
    if (price === null) continue;

    const region = meter.armRegionName || meter.location || "global";
    const key = `${canonicalKey(modelName)}|${region}`;
    const entry = perRegion.get(key) ?? {
      modelName,
      region,
      location: meter.location ?? null,
      prices: {},
      meters: []
    };

    const existing = entry.prices[tokenKind];
    if (!existing || isNewerMeter(meter, existing.meter)) {
      entry.prices[tokenKind] = { price, meter };
    }
    entry.meters.push(compactMeter(meter));
    perRegion.set(key, entry);
  }

  const byRate = new Map();
  for (const entry of perRegion.values()) {
    const input = entry.prices.input?.price ?? null;
    const cachedInput = entry.prices.cachedInput?.price ?? input;
    const output = entry.prices.output?.price ?? null;
    if (input === null || output === null) continue;

    const key = [
      canonicalKey(entry.modelName),
      formatRateKey(input),
      formatRateKey(cachedInput),
      formatRateKey(output)
    ].join("|");
    const group = byRate.get(key) ?? {
      modelName: entry.modelName,
      input,
      cachedInput,
      output,
      regions: [],
      locations: [],
      meters: []
    };
    group.regions.push(entry.region);
    if (entry.location) group.locations.push(entry.location);
    group.meters.push(...entry.meters);
    byRate.set(key, group);
  }

  return [...byRate.values()].map((group) => {
    const sortedRegions = uniqueSorted(group.regions);
    const sourceSuffix =
      sortedRegions.length === 1
        ? `region ${sortedRegions[0]}`
        : `${sortedRegions.length} regions with identical rates`;
    return createVariant({
      sourceKey: `azure-foundry-${group.modelName}-${group.input}-${group.cachedInput}-${group.output}`,
      label: group.modelName,
      modelSlug: slugify(group.modelName),
      provider: "Azure AI Foundry",
      route: "azure-foundry-global-standard",
      taskTags: compact(["azure", "foundry", "global-standard", familyTag(group.modelName)]),
      options: {
        reasoning: reasoningFor(group.modelName),
        effort: effortFor(group.modelName),
        speed: "global-standard",
        speedMultiplier: 1
      },
      pricing: {
        input: group.input,
        cachedInput: group.cachedInput,
        output: group.output,
        unit: "usd_per_1m_tokens",
        source: `Azure Retail Prices API Foundry Models Global Standard PAYG token meters; ${sourceSuffix}.`
      },
      metadata: {
        regions: sortedRegions,
        locations: uniqueSorted(group.locations),
        regionCount: sortedRegions.length,
        meters: group.meters.slice(0, 40)
      }
    });
  });
}

function isAzureGlobalStandardPaygTokenMeter(item) {
  const haystack = [
    item.productName,
    item.skuName,
    item.meterName,
    item.armSkuName,
    item.unitOfMeasure
  ]
    .filter(Boolean)
    .join(" ");
  const deploymentText = [item.skuName, item.meterName].filter(Boolean).join(" ");
  if (item.currencyCode !== "USD") return false;
  if (item.serviceName !== "Foundry Models") return false;
  if (item.type !== "Consumption") return false;
  if (Number(item.tierMinimumUnits ?? 0) !== 0) return false;
  if (!/tokens?/i.test(`${item.unitOfMeasure} ${item.meterName}`)) return false;
  if (!/(?:\bgl\b|glbl|global)/i.test(deploymentText)) return false;
  if (/\b(?:dz|dzone|data\s*zone|regional|regnl|serverless|provisioned|ptu|batch|prty|priority|pp)\b/i.test(haystack)) {
    return false;
  }
  if (/(?:fine[-\s]?tun|(?:^|\b)ft(?:\b|[-_])|model\s*grader)/i.test(haystack)) {
    return false;
  }
  if (/(?:media|image|img|audio|aud|realtime|\brt\b|embedding|embed|vision|sora|whisper|tts|transcrib|dall|search|grounding|rerank|computer)/i.test(haystack)) {
    return false;
  }
  return true;
}

function cleanAzureModelName(item) {
  const product = String(item.productName ?? "");
  let text = String(item.skuName || item.meterName || item.armSkuName || "");
  text = text.replace(/\b1M\s+Tokens?\b|\bTokens?\b/gi, " ");
  text = text.replace(/\b(?:cached|cache|cchd|cd|inp|input|inpt|outp|output|outpt|opt|gl|glbl|global)\b/gi, " ");
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/-+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";

  if (/Azure OpenAI GPT5/i.test(product) && /^[0-9]/.test(text)) {
    text = `GPT-${text}`;
  } else if (/Azure OpenAI/i.test(product) && /^gpt\b/i.test(text)) {
    text = text.replace(/^gpt\s+/i, "GPT-");
  } else if (/Azure OpenAI Reasoning/i.test(product) && /^codex\b/i.test(text)) {
    text = `GPT-${text}`;
  } else if (/Deepseek/i.test(product) && !/^DeepSeek\b/i.test(text)) {
    text = `DeepSeek ${text}`;
  } else if (/Kimi/i.test(product) && !/^Kimi\b/i.test(text)) {
    text = `Kimi ${text}`;
  } else if (/Grok/i.test(product) && !/^Grok(?:\b|\d)/i.test(text)) {
    text = `Grok ${text}`;
  } else if (/Mistral/i.test(product) && !/^Mistral\b|^Codestral\b/i.test(text)) {
    text = `Mistral ${text}`;
  }

  return titleModelName(text);
}

function azureTokenKind(item) {
  const text = `${item.skuName ?? ""} ${item.meterName ?? ""} ${item.armSkuName ?? ""}`;
  if (/\b(?:cached|cache|cchd|cd)\b/i.test(text) && /\b(?:inp|input|inpt)\b/i.test(text)) {
    return "cachedInput";
  }
  if (/\b(?:inp|input|inpt)\b/i.test(text)) return "input";
  if (/\b(?:outp|output|outpt|opt)\b/i.test(text)) return "output";
  return null;
}

function azurePricePerMillion(item) {
  const price = numberOrNull(item.retailPrice ?? item.unitPrice);
  if (price === null) return null;
  const unit = String(item.unitOfMeasure ?? "");
  if (/1M/i.test(unit)) return roundRate(price);
  if (/1K/i.test(unit)) return roundRate(price * 1000);
  return null;
}

function isNewerMeter(next, previous) {
  return new Date(next.effectiveStartDate ?? 0).getTime() >= new Date(previous.effectiveStartDate ?? 0).getTime();
}

function compactMeter(meter) {
  return {
    region: meter.armRegionName ?? null,
    meterName: meter.meterName ?? null,
    skuName: meter.skuName ?? null,
    unitOfMeasure: meter.unitOfMeasure ?? null,
    retailPrice: meter.retailPrice ?? null,
    effectiveStartDate: meter.effectiveStartDate ?? null
  };
}

function buildCatalogIndex(catalog) {
  const index = new Map();
  for (const model of catalog) {
    for (const key of [model.name, model.id, model.id?.split("/").at(-1)]) {
      if (key) index.set(canonicalKey(cleanModelName(key)), model);
    }
  }
  return index;
}

function createVariant({
  sourceKey,
  label,
  modelSlug,
  provider,
  route,
  taskTags,
  options,
  pricing,
  metadata = {}
}) {
  return {
    id: slugify(sourceKey),
    label: cleanModelName(label),
    modelSlug,
    provider,
    route,
    taskTags: uniqueSorted(taskTags.map(String).map(slugify).filter(Boolean)),
    options,
    pricing: normalizePricing(pricing),
    metadata: pruneNullish(metadata)
  };
}

function normalizePricing(pricing) {
  return pruneNullish({
    input: numberOrNull(pricing.input),
    cachedInput: numberOrNull(pricing.cachedInput),
    output: numberOrNull(pricing.output),
    cacheWrite: numberOrNull(pricing.cacheWrite),
    cacheWrite1h: numberOrNull(pricing.cacheWrite1h),
    unit: pricing.unit,
    source: pricing.source
  });
}

function hasUsablePricing(variant) {
  return variant.pricing.input !== null && variant.pricing.input !== undefined && variant.pricing.output !== null && variant.pricing.output !== undefined;
}

function dedupeVariants(variants) {
  const byId = new Map();
  for (const variant of variants) {
    let id = variant.id;
    let suffix = 2;
    while (byId.has(id)) {
      id = `${variant.id}-${suffix}`;
      suffix += 1;
    }
    byId.set(id, { ...variant, id });
  }
  return [...byId.values()];
}

function sortVariants(variants) {
  return variants.sort((a, b) =>
    [a.provider, a.route, a.label, a.id].join("|").localeCompare([b.provider, b.route, b.label, b.id].join("|"))
  );
}

function sortSourceReports(sources) {
  return [...sources].sort((a, b) => a.id.localeCompare(b.id));
}

function parseMarkdownTable(markdown, requiredHeaders) {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith("|")) continue;
    const header = splitMarkdownRow(line);
    if (!requiredHeaders.every((required) => header.includes(required))) continue;
    const rows = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowLine = lines[rowIndex];
      if (!rowLine.trim().startsWith("|")) break;
      const cells = splitMarkdownRow(rowLine);
      rows.push(Object.fromEntries(header.map((key, cellIndex) => [key, cells[cellIndex] ?? ""])));
    }
    return rows;
  }
  throw new Error(`Could not find markdown table with headers: ${requiredHeaders.join(", ")}`);
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function creditsToDollars(value, creditValue) {
  const number = numberOrNull(value);
  if (number === null) return null;
  return roundRate(number / creditValue.creditsPerDollar);
}

async function fetchJson(url, options = {}) {
  const { response, text, attempts } = await fetchBody(url, options);
  if (!response.ok) {
    throw new Error(httpErrorMessage(response, text, attempts));
  }
  if (/^\s*</.test(text)) {
    throw new Error(`Expected JSON but received HTML: ${text.slice(0, 120)}`);
  }
  return JSON.parse(text);
}

async function fetchText(url, options = {}) {
  const { response, text, attempts } = await fetchBody(url, options);
  if (!response.ok) {
    throw new Error(httpErrorMessage(response, text, attempts));
  }
  return text;
}

function httpErrorMessage(response, text, attempts) {
  const body = text.replace(/\s+/g, " ").trim().slice(0, 180);
  const retryAfter = response.headers.get("retry-after");
  const reset = response.headers.get("x-ratelimit-reset");
  const resetText = reset ? ` reset=${new Date(Number(reset) * 1000).toISOString()}` : "";
  const retryText = retryAfter ? ` retry-after=${retryAfter}` : "";
  const hint =
    response.status === 429
      ? " rate limited; retry later or set an auth token for this source"
      : "";
  return `HTTP ${response.status} after ${attempts} attempts:${hint}${retryText}${resetText}${body ? `: ${body}` : ""}`;
}

async function fetchBody(url, options = {}) {
  const { label = url, maxRetries = args.maxRetries, ...fetchOptions } = options;
  let lastNetworkError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptNumber = attempt + 1;
    try {
      const response = await fetch(url, fetchOptions);
      const text = await response.text();
      if (!shouldRetryStatus(response.status) || attempt === maxRetries) {
        return { response, text, attempts: attemptNumber };
      }

      const delayMs = retryDelayMs(response, attempt);
      const statusHint = response.status === 429 ? "rate limited" : `HTTP ${response.status}`;
      log(
        `${label}: ${statusHint}; retry ${attemptNumber}/${maxRetries} in ${formatDuration(delayMs)}`
      );
      await sleep(delayMs);
    } catch (error) {
      lastNetworkError = error;
      if (attempt === maxRetries) break;
      const delayMs = retryDelayMs(null, attempt);
      log(
        `${label}: network error ${error instanceof Error ? error.message : String(error)}; retry ${attemptNumber}/${maxRetries} in ${formatDuration(delayMs)}`
      );
      await sleep(delayMs);
    }
  }

  throw lastNetworkError ?? new Error(`${label}: fetch failed`);
}

function shouldRetryStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(response, attempt) {
  const headerDelay = response ? retryHeaderDelayMs(response) : null;
  const exponential = args.retryBaseMs * 2 ** attempt;
  const rawDelay = headerDelay ?? exponential;
  const jitter = headerDelay === null ? 0.8 + Math.random() * 0.4 : 1;
  return Math.max(0, Math.min(args.maxRetryDelayMs, Math.round(rawDelay * jitter)));
}

function retryHeaderDelayMs(response) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }

  const reset = response.headers.get("x-ratelimit-reset");
  if (reset) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) return Math.max(0, resetMs - Date.now());
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function githubHeaders() {
  return {};
}

async function getGithubAuth() {
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, source: "GITHUB_TOKEN" };
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 3000 });
    const token = stdout.trim();
    return token ? { token, source: "gh auth token" } : null;
  } catch {
    return null;
  }
}

function parseMoney(value) {
  return parseLooseNumber(value);
}

function parseMoneyPerMillion(value) {
  return parseLooseNumber(value);
}

function parseCredits(value) {
  return parseLooseNumber(value);
}

function parseLooseNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function numberOrNull(value) {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function roundRate(value) {
  return Number(Number(value).toFixed(9));
}

function formatRateKey(value) {
  return value === null || value === undefined ? "null" : Number(value).toFixed(9);
}

function cleanModelName(value) {
  return String(value ?? "")
    .replace(/\[\^\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMarkdown(value) {
  return cleanModelName(String(value ?? "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"));
}

function canonicalKey(value) {
  return cleanModelName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function slugify(value) {
  return cleanModelName(value)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleCase(value) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function titleModelName(value) {
  return cleanModelName(value)
    .split(" ")
    .map((part) => {
      if (/^(gpt|mai|glm|oss|api|r1|v\d|k\d|fp8)$/i.test(part)) return part.toUpperCase();
      if (/^gpt-/i.test(part)) return part.replace(/^gpt/i, "GPT");
      if (/^o\d/i.test(part)) return part.toLowerCase();
      if (/^\d+(?:\.\d+)*$/.test(part)) return part;
      if (/^[A-Z0-9.-]+$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ")
    .replace(/^GPT-?(\d)/, "GPT-$1")
    .replace(/\bCodex\b/i, "Codex")
    .replace(/\bMini\b/g, "Mini")
    .replace(/\bNano\b/g, "Nano");
}

function reasoningFor(model, capabilities = []) {
  const text = `${model} ${(capabilities ?? []).join(" ")}`;
  return /(reasoning|o\d|opus|sonnet|gpt-5|grok|deepseek|thinking|codex)/i.test(text)
    ? "reasoning"
    : "standard";
}

function effortFor(value) {
  const text = String(value ?? "");
  if (/(powerful|opus|pro|max|gpt-5\.5|gpt-5\.4|o3|o4|r1|reasoning)/i.test(text)) return "high";
  if (/(lightweight|mini|nano|haiku|flash|small|fast)/i.test(text)) return "standard";
  return "standard";
}

function familyTag(model) {
  const text = String(model ?? "");
  if (/claude/i.test(text)) return "claude";
  if (/gpt|codex|o\d/i.test(text)) return "openai";
  if (/grok/i.test(text)) return "xai";
  if (/gemini/i.test(text)) return "google";
  if (/deepseek/i.test(text)) return "deepseek";
  if (/mistral|codestral/i.test(text)) return "mistral";
  if (/kimi/i.test(text)) return "kimi";
  if (/llama/i.test(text)) return "meta";
  return null;
}

function compact(values) {
  return values.flat().filter((value) => value !== null && value !== undefined && value !== "");
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function pruneNullish(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === null || entry === undefined) return false;
      if (Array.isArray(entry) && entry.length === 0) return false;
      if (typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length === 0) return false;
      return true;
    })
  );
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

function parseArgs(argv) {
  const parsed = {
    output: null,
    dryRun: false,
    strict: false,
    includeDeprecated: false,
    quiet: false,
    maxRetries: 4,
    retryBaseMs: 1000,
    maxRetryDelayMs: 30_000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "--include-deprecated") parsed.includeDeprecated = true;
    else if (arg === "--quiet") parsed.quiet = true;
    else if (arg === "--output") parsed.output = argv[++index];
    else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length);
    else if (arg === "--max-retries") parsed.maxRetries = parseNonNegativeInteger(argv[++index], arg);
    else if (arg.startsWith("--max-retries=")) parsed.maxRetries = parseNonNegativeInteger(arg.slice("--max-retries=".length), "--max-retries");
    else if (arg === "--retry-base-ms") parsed.retryBaseMs = parseNonNegativeInteger(argv[++index], arg);
    else if (arg.startsWith("--retry-base-ms=")) parsed.retryBaseMs = parseNonNegativeInteger(arg.slice("--retry-base-ms=".length), "--retry-base-ms");
    else if (arg === "--max-retry-delay-ms") parsed.maxRetryDelayMs = parseNonNegativeInteger(argv[++index], arg);
    else if (arg.startsWith("--max-retry-delay-ms=")) parsed.maxRetryDelayMs = parseNonNegativeInteger(arg.slice("--max-retry-delay-ms=".length), "--max-retry-delay-ms");
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/update-model-routes.mjs [--dry-run] [--strict] [--quiet] [--include-deprecated] [--output PATH]

Options:
  --max-retries N             Retry retryable HTTP/network failures N times. Default: 4.
  --retry-base-ms N           Initial exponential-backoff delay. Default: 1000.
  --max-retry-delay-ms N      Cap any single retry delay. Default: 30000.

Environment:
  GITHUB_TOKEN                 Raises GitHub Models Catalog/API rate limits; falls back to gh auth token.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function parseNonNegativeInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return number;
}
