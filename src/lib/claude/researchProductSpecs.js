// src/lib/claude/researchProductSpecs.js
//
// Bulk-import's per-item research call — duplicated from golfcare-backend's
// src/services/supplierAgent/productResearch.js (can't require() across
// repos). That version runs through backend's toolLoop.js; this repo has
// no equivalent, so it's a single anthropic.messages.create call instead —
// same reasoning as draftDynamicTemplate.js's header comment: web_search/
// web_fetch are server tools Anthropic resolves WITHIN one response, no
// client-side multi-turn loop needed.
//
// Pinned to Sonnet unconditionally, same reasoning as the backend version —
// infrequent, needs reliable JSON output, not worth Haiku's risk.

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-4-6";
const SONNET_RATE = { inputPerMtok: 3, outputPerMtok: 15 };
const USD_TO_INR = 95;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a focused product-research assistant for a golf retail catalog. Given a product name (and optionally a brand), use web_search then web_fetch on the most relevant result to find real specs and a real product image.

Respond with ONLY a JSON object, no other text, no markdown code fences:
{"specs": "...", "imageUrl": "..." or null, "sourceNotes": "..."}

- specs: 2-4 sentences of prose (materials, construction, features, condition) — never restate the brand, SKU, or size, those aren't needed here.
- imageUrl: a real, direct image URL you found via web_fetch (an og:image meta tag or a product image src) — never a product PAGE url, never a guessed or constructed url. Use null if you can't confirm a real one.
- sourceNotes: one short sentence citing where this came from.

If you can't find anything useful after searching, respond with {"specs": null, "imageUrl": null, "sourceNotes": "not found"}.`;

const TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 3 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 3 },
];

function parseResponse(text) {
  const cleaned = (text || "")
    .replace(/^```(json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { specs: null, imageUrl: null, sourceNotes: "research_response_unparseable" };
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
 * @param {string} input.title
 * @param {string} [input.brand]
 * @returns {Promise<{specs: string|null, imageUrl: string|null, sourceNotes: string|null, usage: {inputTokens: number, outputTokens: number}, cost: {usd: number, inr: number}}>}
 */
async function researchProductSpecs({ title, brand }) {
  const query = brand ? `${brand} ${title}` : title;
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages: [{ role: "user", content: `Product: ${query}` }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const usage = {
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
  };
  const parsed = parseResponse(text);

  return {
    specs: parsed.specs || null,
    imageUrl: parsed.imageUrl || null,
    sourceNotes: parsed.sourceNotes || null,
    usage,
    cost: computeCost(usage),
  };
}

module.exports = { researchProductSpecs };
