// src/lib/claude/modelConfig.js
//
// One place for which Claude model each bulk-import step uses, what it
// costs, and the per-model request settings that differ between model
// generations. extractBulkCatalogItems.js and researchProductSpecs.js both
// read from here, and productImportDrain.js logs the real model name to
// AgentUsage from here, instead of each file hardcoding "claude-sonnet-4-6"
// and its own copy of the Sonnet 4.6 rate.
//
// Switching a step to a different model is an env change, no code change:
//   PRODUCT_IMPORT_EXTRACT_MODEL   (reading the supplier's PDF/XLSX/DOCX)
//   PRODUCT_IMPORT_RESEARCH_MODEL  (web search for specs + images)

const USD_TO_INR = 95;

// USD per million tokens. Haiku 5.5 has two rate cards chosen by prompt
// length (100K tokens or fewer, or longer).
const PRICING = {
  "claude-sonnet-4-6": { inputPerMtok: 3, outputPerMtok: 15 },
  "claude-sonnet-5-5": { inputPerMtok: 2, outputPerMtok: 10 },
  "claude-haiku-5-5": {
    inputPerMtok: 0.1,
    outputPerMtok: 0.5,
    longPrompt: { thresholdTokens: 100_000, inputPerMtok: 0.5, outputPerMtok: 2.5 },
  },
};

// Billed separately from tokens: $10 per 1,000 web searches. Web fetch
// has no per-call fee (only the fetched content's tokens).
const WEB_SEARCH_USD_EACH = 0.01;

// Defaults chosen from a side-by-side test on real supplier documents
// (Nov 2026: Bhiwandi XLSX rows, TRINITY PDF pages, 2 research products),
// Sonnet 4.6 vs Haiku 5.5 vs Sonnet 5.5:
//  - extraction: Haiku 5.5 was the only one to keep all 20 priced rows
//    (Sonnet 5.5 merged away 5 size rows), at ~1/17th Sonnet 4.6's cost.
//  - research: Haiku 5.5 got correct specs for both products and the only
//    real product photo, at ₹1.3-1.5 per product (Sonnet 5.5: ₹5.5-11;
//    the old Sonnet 4.6 setup averaged ~₹23 per product on the live run).
const EXTRACT_MODEL = process.env.PRODUCT_IMPORT_EXTRACT_MODEL || "claude-haiku-5-5";
const RESEARCH_MODEL = process.env.PRODUCT_IMPORT_RESEARCH_MODEL || "claude-haiku-5-5";

function isNewGeneration(model) {
  // Sonnet 5.5 / Haiku 5.5: thinking is ON by default and counts toward
  // max_tokens, and `effort` controls how much they think.
  return model !== "claude-sonnet-4-6";
}

/**
 * Extra request fields for a given model. Extraction and research are
 * both simple, well-specified tasks, so newer models run at "low" effort —
 * they skip thinking on most such requests instead of spending output
 * tokens on it.
 */
function requestOptions(model) {
  if (!isNewGeneration(model)) return {};
  return { output_config: { effort: "low" } };
}

/**
 * max_tokens to send. Newer models need headroom for thinking on top of
 * the answer itself (thinking counts toward max_tokens even when its text
 * isn't returned) — only tokens actually generated are billed, so a higher
 * cap costs nothing extra by itself.
 */
function maxTokensFor(model, answerTokens) {
  return isNewGeneration(model) ? answerTokens + 4096 : answerTokens;
}

/**
 * Web search/fetch tool definitions for the research step.
 *  - max_uses 2 each (down from 3): one good search + one or two page
 *    reads was enough on the real runs; the third fetch was mostly paying
 *    for a page that didn't help.
 *  - max_content_tokens caps how much of each fetched page enters the
 *    prompt. Uncapped, a retailer's product page (menus, reviews, footers,
 *    related products) ran 30-50K tokens — that input, not the model's
 *    answer, was ~77% of the whole bulk-import bill.
 * Only Sonnet 5.5 gets the newer tool versions (dynamic filtering: the
 * model filters results with code before they reach the prompt). Haiku
 * 5.5 doesn't support them. Sonnet 4.6 does, but confirmed live (Nov 2026
 * model comparison) that on 4.6 they ran away: 745K input tokens and ₹228
 * for just 2 products, versus ₹2.80 for the same 2 on Haiku 5.5 with the
 * basic versions — so 4.6 stays on the basic versions too.
 */
function researchTools(model) {
  const supportsDynamicFiltering = model === "claude-sonnet-5-5";
  return [
    {
      type: supportsDynamicFiltering ? "web_search_20260209" : "web_search_20250305",
      name: "web_search",
      max_uses: 2,
    },
    {
      type: supportsDynamicFiltering ? "web_fetch_20260209" : "web_fetch_20250910",
      name: "web_fetch",
      max_uses: 2,
      max_content_tokens: 5000,
    },
  ];
}

/**
 * @param {string} model
 * @param {{inputTokens: number, outputTokens: number, webSearches?: number}} usage
 * @returns {{usd: number, inr: number}}
 */
function computeCost(model, { inputTokens, outputTokens, webSearches = 0 }) {
  const rate = PRICING[model] || PRICING["claude-sonnet-4-6"];
  // A tool-using response reports input summed across its internal steps,
  // so this picks the long-prompt card a little early — errs toward
  // over-reporting cost, never under.
  const card = rate.longPrompt && inputTokens > rate.longPrompt.thresholdTokens ? rate.longPrompt : rate;
  const usd =
    (inputTokens / 1_000_000) * card.inputPerMtok +
    (outputTokens / 1_000_000) * card.outputPerMtok +
    webSearches * WEB_SEARCH_USD_EACH;
  return { usd, inr: usd * USD_TO_INR };
}

/** Pulls token + web-search counts out of a Messages API response. */
function usageFromResponse(response) {
  return {
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
    webSearches: response.usage?.server_tool_use?.web_search_requests || 0,
  };
}

module.exports = {
  EXTRACT_MODEL,
  RESEARCH_MODEL,
  requestOptions,
  maxTokensFor,
  researchTools,
  computeCost,
  usageFromResponse,
};
