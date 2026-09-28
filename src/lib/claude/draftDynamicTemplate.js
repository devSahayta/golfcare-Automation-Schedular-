// src/lib/claude/draftDynamicTemplate.js
//
// Module 6 — the dynamic-template lane's only Claude call. Deliberately
// NOT a tool loop (no equivalent of golfcare-backend's toolLoop.js here)
// — this is a one-shot, no-tools text-generation task, same spirit as
// golfcare-backend/src/services/supplierAgent/productResearch.js's
// isolated call but simpler still (no web_search/web_fetch).
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
    };
  } catch {
    return { bodyText: null, variables: [], category: "MARKETING" };
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
 * @returns {Promise<{bodyText: string|null, variables: string[], category: "MARKETING"|"UTILITY", usage: {inputTokens: number, outputTokens: number}, cost: {usd: number, inr: number}}>}
 */
async function draftDynamicTemplate({
  scenario,
  customerFirstName,
  productTitle,
  productUpsellContext,
}) {
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
    system: SYSTEM_PROMPT,
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

  return { ...parsed, usage, cost: computeCost(usage) };
}

module.exports = { draftDynamicTemplate };
