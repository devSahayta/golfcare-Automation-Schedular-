// src/lib/claude/researchProductSpecs.js
//
// Bulk-import's research calls — duplicated from golfcare-backend's
// src/services/supplierAgent/productResearch.js (can't require() across
// repos). That version runs through backend's toolLoop.js; this repo has
// no equivalent, so it's a single anthropic.messages.create call instead —
// same reasoning as draftDynamicTemplate.js's header comment: web_search/
// web_fetch are server tools Anthropic resolves WITHIN one response, no
// client-side multi-turn loop needed.
//
// Pinned to Sonnet unconditionally, same reasoning as the backend version —
// infrequent, needs reliable JSON output, not worth Haiku's risk.
//
// Two entry points, sharing this file's Anthropic client/cost math:
//   - researchProductSpecs: runs ONCE per item, for the product's specs
//     text. needsImage controls whether it ALSO searches for a photo —
//     false whenever the document already supplied one (see
//     pdfImageExtractor.js / extractBulkCatalogItems.js), which is the
//     actual cost saving this split exists for: no point paying for
//     web_search/web_fetch tool calls hunting an image we already have.
//   - researchVariantImage: runs once PER VARIANT still missing a document
//     image, but only when the item genuinely has more than one real
//     variant (processItem.js keeps using researchProductSpecs's own
//     imageUrl for the common single-variant case — unchanged, zero extra
//     cost there). Image-only prompt, scoped to one specific color/size,
//     so a 4-color belt with no document photos runs 4 of these, not one
//     shared search reused across all 4 — confirmed/accepted trade-off.

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-4-6";
const SONNET_RATE = { inputPerMtok: 3, outputPerMtok: 15 };
const USD_TO_INR = 95;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 3 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 3 },
];

const SPECS_WITH_IMAGE_PROMPT = `You are a focused product-research assistant for a golf retail catalog. Given a product name (and optionally a brand), use web_search then web_fetch on the most relevant result to find real specs and a real product image.

Respond with ONLY a JSON object, no other text, no markdown code fences:
{"specs": "...", "imageUrl": "..." or null, "sourceNotes": "..."}

- specs: 2-4 sentences of prose (materials, construction, features, condition) — never restate the brand, SKU, or size, those aren't needed here.
- imageUrl: a real, direct image URL you found via web_fetch (an og:image meta tag or a product image src) — never a product PAGE url, never a guessed or constructed url. Use null if you can't confirm a real one.
- sourceNotes: one short sentence citing where this came from.

If you can't find anything useful after searching, respond with {"specs": null, "imageUrl": null, "sourceNotes": "not found"}.`;

// Used whenever every variant of this item already has a document-sourced
// image — drops the image field/instruction entirely rather than asking
// the model to search for (and potentially fetch extra pages hunting) a
// photo that's just going to be discarded.
const SPECS_ONLY_PROMPT = `You are a focused product-research assistant for a golf retail catalog. Given a product name (and optionally a brand), use web_search then web_fetch on the most relevant result to find real specs.

Respond with ONLY a JSON object, no other text, no markdown code fences:
{"specs": "...", "sourceNotes": "..."}

- specs: 2-4 sentences of prose (materials, construction, features, condition) — never restate the brand, SKU, or size, those aren't needed here.
- sourceNotes: one short sentence citing where this came from.

If you can't find anything useful after searching, respond with {"specs": null, "sourceNotes": "not found"}.`;

const VARIANT_IMAGE_PROMPT = `You are a focused product-research assistant for a golf retail catalog. Given a product name, brand, and a specific color/size variant, use web_search then web_fetch to find a real photo specifically of THAT variant — not just any photo of the product.

Respond with ONLY a JSON object, no other text, no markdown code fences:
{"imageUrl": "..." or null, "sourceNotes": "..."}

- imageUrl: a real, direct image URL you found via web_fetch (an og:image meta tag or a product image src) that clearly shows the requested color/size — never a product PAGE url, never a guessed or constructed url, never a different variant's photo passed off as this one. Use null if you can't confirm a real match for this specific variant.
- sourceNotes: one short sentence citing where this came from.

If you can't find a confirmable photo of this specific variant, respond with {"imageUrl": null, "sourceNotes": "not found"}.`;

// With tool use (web_search/web_fetch), Claude frequently emits an interim
// narration text block ("Let me fetch that page...") BEFORE its final JSON
// answer — joining every text block with "\n" (the naive approach) then
// has prose sitting in front of the JSON, which fails to parse even though
// a real, valid JSON object is sitting right there in the same string.
// Confirmed live: reproduced on 2 of 2 real researchVariantImage calls.
// Pulling the substring between the first "{" and the last "}" sidesteps
// this regardless of whether narration lands before, after, or around it.
function parseJson(text, fallback) {
  const raw = (text || "").replace(/```(json)?/gi, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return fallback;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return fallback;
  }
}

function computeCost(usage) {
  const usd =
    (usage.inputTokens / 1_000_000) * SONNET_RATE.inputPerMtok +
    (usage.outputTokens / 1_000_000) * SONNET_RATE.outputPerMtok;
  return { usd, inr: usd * USD_TO_INR };
}

async function runResearchCall(systemPrompt, userContent, maxTokens) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    tools: TOOLS,
    messages: [{ role: "user", content: userContent }],
  });
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const usage = {
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
  };
  return { text, usage };
}

/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} [input.brand]
 * @param {boolean} [input.needsImage] - false when every variant already has
 *        a document-sourced image (skips the image field/search entirely,
 *        the actual cost saving); true (default) keeps the combined
 *        specs+image behavior, used as-is for a single-variant item with no
 *        document image.
 * @returns {Promise<{specs: string|null, imageUrl: string|null, sourceNotes: string|null, usage: {inputTokens: number, outputTokens: number}, cost: {usd: number, inr: number}}>}
 */
async function researchProductSpecs({ title, brand, needsImage = true }) {
  const query = brand ? `${brand} ${title}` : title;
  const { text, usage } = await runResearchCall(
    needsImage ? SPECS_WITH_IMAGE_PROMPT : SPECS_ONLY_PROMPT,
    `Product: ${query}`,
    512,
  );
  const parsed = parseJson(text, { specs: null, imageUrl: null, sourceNotes: "research_response_unparseable" });

  return {
    specs: parsed.specs || null,
    imageUrl: needsImage ? parsed.imageUrl || null : null,
    sourceNotes: parsed.sourceNotes || null,
    usage,
    cost: computeCost(usage),
  };
}

/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} [input.brand]
 * @param {string} input.variantValue - e.g. "Red", "XL" — the specific
 *        color/size this call must find a photo of.
 * @returns {Promise<{imageUrl: string|null, sourceNotes: string|null, usage: {inputTokens: number, outputTokens: number}, cost: {usd: number, inr: number}}>}
 */
async function researchVariantImage({ title, brand, variantValue }) {
  const query = brand ? `${brand} ${title}` : title;
  const { text, usage } = await runResearchCall(
    VARIANT_IMAGE_PROMPT,
    `Product: ${query}\nVariant: ${variantValue}`,
    384,
  );
  const parsed = parseJson(text, { imageUrl: null, sourceNotes: "research_response_unparseable" });

  return {
    imageUrl: parsed.imageUrl || null,
    sourceNotes: parsed.sourceNotes || null,
    usage,
    cost: computeCost(usage),
  };
}

module.exports = { researchProductSpecs, researchVariantImage };
