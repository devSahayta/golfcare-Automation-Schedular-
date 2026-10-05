// src/lib/claude/draftDynamicTemplate.js
//
// Module 6 — the dynamic-template lane's only Claude call. Deliberately
// NOT a client-side tool loop (no equivalent of golfcare-backend's
// toolLoop.js here) — web_search/web_fetch are server tools Anthropic
// executes and resolves WITHIN the one response, so no multi-turn loop
// is needed on our side even when they're enabled (confirmed from this
// same pattern in golfcare-backend/src/services/supplierAgent/
// productResearch.js — every real call there finished in one iteration
// despite being wired through a loop capable of more). Those tools are
// only enabled when there's no local product image already on file
// (see localImageUrl) — the common case (a real Shopify-synced photo
// already exists) skips them entirely, no extra tokens spent.
//
// Pinned to Sonnet unconditionally, same reasoning as productResearch.js:
// this runs infrequently (only when a genuine personalization scenario —
// e.g. cross-sell — is detected, not on every trigger-eval tick), so
// paying Sonnet's rate here is cheap relative to the value of a reliable
// "always return valid JSON" response. There is no cheaper-model fallback
// to reuse here since this repo has no toolLoop.js/modelRouter.js — it's
// the first and only Claude call site in this repo.
//
// Cost is tracked on the DynamicTemplate row itself (draftInputTokens/
// draftOutputTokens/draftCostUsd/draftCostInr), not via an AgentUsage
// row — a proactive campaign draft has no Conversation to hang
// AgentUsage.conversationId off of, and duplicating that whole
// relationship into this repo for one column's worth of data wasn't
// worth it. The rate below is a duplicate of golfcare-backend's
// modelPricing.js MODEL_PRICING_USD_PER_MTOK["claude-sonnet-4-6"] entry
// — keep in sync if that ever changes.

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-4-6";
const SONNET_RATE = { inputPerMtok: 3, outputPerMtok: 15 };
const USD_TO_INR = 95;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are drafting a single WhatsApp marketing message template for a golf retail business. Given a customer and a product/context, write ONE short, warm, personalized message.

Respond with ONLY a JSON object, no other text, no markdown code fences:
{"bodyText": "...", "variables": ["...", "..."], "category": "MARKETING" or "UTILITY"}

- bodyText: the message, using {{1}}, {{2}}, ... as placeholders for anything personalized (customer name, product name, etc.) — never hardcode the actual name/product in bodyText itself, always use a placeholder.
- variables: the ordered array of REAL values that fill {{1}}, {{2}}, ... in order — e.g. if bodyText has {{1}} and {{2}}, variables must have exactly 2 entries.
- category: "MARKETING" for a promotional/cross-sell message, "UTILITY" for a transactional/informational one. Default to MARKETING unless the content is purely transactional.

Keep bodyText under 300 characters, one clear idea, no more than one placeholder-driven personalization beyond the customer's name. Never invent a price, discount, or claim not given to you in the context.`;

// Only used when the caller has no local product image already (see
// draftDynamicTemplate's localImageUrl param) — asks Claude to ALSO find
// a real image via web_search/web_fetch, same "never show a customer
// something unverified as fact" principle as
// golfcare-backend/src/services/supplierAgent/productResearch.js (never
// a generated/synthetic image). Appended to the base prompt rather than
// a separate one, so there's only one prompt to keep in sync.
const IMAGE_SEARCH_ADDENDUM = `

Also use web_search then web_fetch to find a real, direct product image URL for the product mentioned (an og:image meta tag or a product image src — never a product PAGE url, never a guessed/constructed url). Add it to the same JSON object as "imageUrl" (a string), or null if you can't confirm a real one:
{"bodyText": "...", "variables": ["...", "..."], "category": "MARKETING" or "UTILITY", "imageUrl": "..." or null}`;

const IMAGE_SEARCH_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 3 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 3 },
];

function parseDraftResponse(text) {
  const cleaned = (text || "")
    .replace(/^```(json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    const category = parsed.category === "UTILITY" ? "UTILITY" : "MARKETING";
    return {
      bodyText: parsed.bodyText || null,
      variables: Array.isArray(parsed.variables) ? parsed.variables.map(String) : [],
      category,
      imageUrl: parsed.imageUrl || null,
    };
  } catch {
    return { bodyText: null, variables: [], category: "MARKETING", imageUrl: null };
  }
}

function computeCost(usage) {
  const usd =
    (usage.inputTokens / 1_000_000) * SONNET_RATE.inputPerMtok +
    (usage.outputTokens / 1_000_000) * SONNET_RATE.outputPerMtok;
  return { usd, inr: usd * USD_TO_INR };
}

/**
 * @param {object} input
 * @param {string} input.scenario - e.g. "CROSS_SELL"
 * @param {string} input.customerFirstName
 * @param {string} [input.productTitle] - the product being upsold
 * @param {string} [input.productUpsellContext] - why this product fits (e.g. the purchased product it follows)
 * @param {string} [input.localImageUrl] - a real image already on file (Product.imageUrls) for the
 *   featured product — when given, skips the web_search fallback entirely (no extra tokens/cost) and
 *   is returned as-is in imageUrl.
 * @returns {Promise<{bodyText: string|null, variables: string[], category: "MARKETING"|"UTILITY", imageUrl: string|null, usage: {inputTokens: number, outputTokens: number}, cost: {usd: number, inr: number}}>}
 */
async function draftDynamicTemplate({
  scenario,
  customerFirstName,
  productTitle,
  productUpsellContext,
  localImageUrl,
}) {
  const needsImageSearch = !localImageUrl && Boolean(productTitle);

  const userMessage = [
    `Scenario: ${scenario}`,
    `Customer first name: ${customerFirstName}`,
    productTitle ? `Product to feature: ${productTitle}` : null,
    productUpsellContext ? `Context: ${productUpsellContext}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: needsImageSearch ? `${SYSTEM_PROMPT}${IMAGE_SEARCH_ADDENDUM}` : SYSTEM_PROMPT,
    ...(needsImageSearch && { tools: IMAGE_SEARCH_TOOLS }),
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const parsed = parseDraftResponse(text);
  const usage = {
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
  };

  return {
    ...parsed,
    imageUrl: localImageUrl || parsed.imageUrl,
    usage,
    cost: computeCost(usage),
  };
}

module.exports = { draftDynamicTemplate };
