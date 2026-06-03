# AI Model Compare

Compare AI LLM intelligence per dollar. Not just token prices, but the effective cost of running real benchmarks.

Disclaimer: this project was vibe coded with Codex GPT-5.5 Extra High.

## Run Locally

```bash
npm install
npm run build:data
npm run dev
```

Open `http://localhost:5173`.

## Updating Data

Regenerate route pricing from live sources:

```bash
npm run update:routes
npm run build:data
```

Commit both `config/model-routes.json` and `public/data/models.json`.

The route updater fetches rates on every invocation and rewrites the full route file. It uses:

- GitHub Models Catalog API
- GitHub Copilot `models-and-pricing.yml`
- Anthropic Claude pricing markdown
- Azure Retail Prices API, filtered to Foundry Models Global Standard PAYG token rates
- OpenAI Help Center Codex rate-card HTML table via Playwright
- OpenAI Help Center Codex credit-value page to convert Codex credits to USD

Progress is printed while each source is fetched, including Azure page counts and retry/backoff messages for 429, 5xx, and network failures. Tune retry behavior with `--max-retries`, `--retry-base-ms`, and `--max-retry-delay-ms`; use `--quiet` to suppress progress logs.

If a source fails and an older `config/model-routes.json` exists, the updater preserves the previous variants for that public source instead of deleting them from the generated file.

Optional updater env vars:

- `GITHUB_TOKEN`: raises GitHub catalog/API rate limits. If unset, the updater tries `gh auth token` before unauthenticated GitHub requests.
- `ARTIFICIAL_ANALYSIS_API_KEY`: lets `npm run build:data -- --refresh-aa` refresh Artificial Analysis benchmark data. Without it, the builder uses the local `.cache` file or the previously committed static payload.

## Provider Overlays

The public site uses public pricing only. Private gateways, allowlists, regional deployments, quotas, or model limits are handled as browser-imported overlays. An overlay does not replace public prices; it adds routes under an imported provider name, matches each imported model to the closest public price route, and can carry Artificial Analysis benchmark matches for provider-specific model names.

Export a LiteLLM-style overlay locally:

```bash
npm run export:overlay -- \
  --url https://example.com/model_group/info \
  --provider "Internal Gateway" \
  --output local/provider-overlay.json
```

`local/` is git-ignored. The exporter accepts `LITELLM_BEARER_TOKEN`, `LITELLM_API_KEY`, or `LITELLM_COOKIE` for private endpoints. Import the generated JSON from the app sidebar; overlays are stored in browser local storage and can be removed without touching committed data.

For benchmark matching, the exporter uses `.cache/artificial-analysis-llms.json`, the committed static payload, or fresh Artificial Analysis data when `ARTIFICIAL_ANALYSIS_API_KEY` is set and `--refresh-aa` is passed. Use `--strict-aa` if an overlay export should fail instead of continuing without benchmark matches. A single imported model can carry multiple `benchmarks` entries when Artificial Analysis has separate reasoning, non-reasoning, or effort-mode rows; the app plots each benchmark mode separately. The app's footer diagnostic reports priced public and imported routes with no benchmark match; imported models with no public price route are not included in that benchmark-gap list.

Overlay JSON shape:

```json
{
  "version": 1,
  "kind": "model-route-overlay",
  "provider": "Internal Gateway",
  "fetchedAt": "2026-06-03T00:00:00.000Z",
  "pricingMode": "public-match",
  "models": [
    {
      "label": "claude-opus-4-5",
      "providerHint": "anthropic",
      "contextWindow": 200000,
      "maxOutputTokens": 32000,
      "benchmarks": []
    }
  ]
}
```

## GitHub Pages

The repository includes:

- `.github/workflows/pages.yml`: builds and deploys the static app to GitHub Pages on `main` or `master`.
- `.github/workflows/update-data.yml`: runs weekly and on demand, updates route/static data, and commits changes when there is a diff.

Enable Pages in the GitHub repository settings and select **GitHub Actions** as the source. For a project page, the workflow sets Vite's `BASE_PATH` to `/<repo-name>/`; for a `*.github.io` user/org page, it uses `/`.

Set either of these optional repository secrets if you want scheduled refreshes for gated sources:

- `ARTIFICIAL_ANALYSIS_API_KEY` (preferred)
- `AA_API_KEY`

## Config Files

The app supports two comparison modes:

- **Task cost** uses Artificial Analysis Intelligence Index token counts and calculates the cost to run that benchmark with each route's input and output prices. Speed in this mode is estimated as benchmark output tokens divided by each route's effective output tokens/sec, so it represents time to complete the benchmark rather than raw token throughput. This mode uses the Intelligence Index task cost for any selected score, so task profiles are hidden.
- **Token cost** uses the editable token blend profiles below.

Edit `config/task-profiles.json` to change token blend assumptions. The token cost model is:

```text
blended_price =
  cachedInputShare * cached_input_price +
  freshInputShare * input_price +
  outputShare * output_price
```

`value = selected_score / blended_price`, shown as score points per dollar per 1M blended tokens.

The default profile uses the current Artificial Analysis blended-price convention: `7:2:1` cache-input-output. Other included profiles are deliberately editable starting points for fresh chat, warm coding agents, reasoning-heavy tasks, and long-context review.

## Data Sources

- Artificial Analysis free API: https://artificialanalysis.ai/api-reference/
- Artificial Analysis caching and blended-price context: https://artificialanalysis.ai/models/caching
- OpenAI prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Gemini context caching: https://ai.google.dev/gemini-api/docs/caching

Artificial Analysis attribution is required for free API usage, so the app links back to `https://artificialanalysis.ai/`.
