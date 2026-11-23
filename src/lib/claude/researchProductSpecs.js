// src/lib/claude/researchProductSpecs.js
//
// Bulk-import's research call — duplicated from golfcare-backend's
// src/services/supplierAgent/productResearch.js (can't require() across
// repos). That version runs through backend's toolLoop.js; this repo has
// no equivalent, so it's a single anthropic.messages.create call instead —
// same reasoning as draftDynamicTemplate.js's header comment: web_search/
// web_fetch are server tools Anthropic resolves WITHIN one response, no
// client-side multi-turn loop needed.
//
// ONE call per new product, covering everything it still needs:
//   - specs text, always;
//   - a single product photo, when it's a single-variant product the
//     document gave no photo for (needsImage);
//   - a photo per color/size, for a multi-variant product, but only for
//     the variants the document didn't already supply a photo for
//     (variantValues).
// This used to be one call for specs plus one SEPARATE call per variant
// missing a photo — a 5-color polo meant 6 calls, each re-searching and
// re-reading the same product pages. On the real Bhiwandi run those
// per-variant calls were the single biggest cost line (₹382 of ~₹1,090).
// The pages a model reads for one color almost always show the others too,
// so one call now asks for all of them at once.
//
// Model, tool limits (max_uses / max_content_tokens) and pricing come from
// modelConfig.js.

const Anthropic = require("@anthropic-ai/sdk");
const modelConfig = require("./modelConfig");

const MODEL = modelConfig.RESEARCH_MODEL;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BASE_INSTRUCTIONS = `You are a focused product-research assistant for a golf retail catalog. Given a product name (and optionally a brand), use web_search, then web_fetch on the most relevant result (prefer the brand's own site or a major retailer), to find real information about that exact product. Keep it short: one good search and one or two page reads is normally enough.

Respond with ONLY a JSON object, no other text, no markdown code fences.`;

const SPECS_RULES = `- specs: 2-4 sentences of prose (materials, construction, features) — never restate the brand, SKU, or size, those aren't needed here. null if you couldn't find real information.
- sourceNotes: one short sentence citing where this came from.`;

const IMAGE_URL_RULE = `Every image URL must be a real, direct image URL you actually saw via web_fetch (an og:image meta tag or a product image src) — never a product PAGE url, never a guessed or constructed url. Use null whenever you can't confirm one.`;

function buildPrompt({ needsImage, variantValues }) {
  if (variantValues.length > 0) {
    return `${BASE_INSTRUCTIONS}
{"specs": "...", "imageUrl": "..." or null, "variantImages": {${variantValues.map((v) => JSON.stringify(v) + ': "..." or null').join(", ")}}, "sourceNotes": "..."}

${SPECS_RULES}
- imageUrl: any one good photo of this product (any color) — used only as the product's main photo, never attached to a specific variant. ${IMAGE_URL_RULE}
- variantImages: for EACH listed color/size, a photo that clearly shows THAT variant. ${IMAGE_URL_RULE} Never reuse one variant's photo for a different one — if you can only confirm photos for some variants, give those and null for the rest. Keep exactly the variant names given as keys.`;
  }
  if (needsImage) {
    return `${BASE_INSTRUCTIONS}
{"specs": "...", "imageUrl": "..." or null, "sourceNotes": "..."}

${SPECS_RULES}
- imageUrl: a photo of this product. ${IMAGE_URL_RULE}`;
  }
  return `${BASE_INSTRUCTIONS}
{"specs": "...", "sourceNotes": "..."}

${SPECS_RULES}`;
}

// With tool use, the model may emit narration text ("Let me fetch that
// page...") before its final JSON answer — pull the substring between the
// first "{" and the last "}" so that narration never breaks parsing.
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

/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} [input.brand]
 * @param {boolean} [input.needsImage] - single-variant product with no
 *        document photo: also find one product photo.
 * @param {string[]} [input.variantValues] - multi-variant product: the
 *        colors/sizes still missing a document photo; one photo is looked
 *        for per value, in this same call.
 * @returns {Promise<{specs: string|null, imageUrl: string|null, variantImages: Record<string, string|null>, sourceNotes: string|null, model: string, usage: {inputTokens: number, outputTokens: number, webSearches: number}, cost: {usd: number, inr: number}}>}
 */
async function researchProductSpecs({ title, brand, needsImage = false, variantValues = [] }) {
  const query = brand ? `${brand} ${title}` : title;
  const wantsVariants = variantValues.length > 0;
  const userContent = wantsVariants
    ? `Product: ${query}\nVariants needing a photo: ${variantValues.join(", ")}`
    : `Product: ${query}`;

  // Answer budget grows with the number of variant URLs requested.
  const answerTokens = 512 + (wantsVariants ? 160 * variantValues.length : 0);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: modelConfig.maxTokensFor(MODEL, answerTokens),
    system: buildPrompt({ needsImage: needsImage && !wantsVariants, variantValues }),
    tools: modelConfig.researchTools(MODEL),
    messages: [{ role: "user", content: userContent }],
    ...modelConfig.requestOptions(MODEL),
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const parsed = parseJson(text, { specs: null, sourceNotes: "research_response_unparseable" });
  const usage = modelConfig.usageFromResponse(response);

  // Only keep image URLs for variants we actually asked about, keyed
  // exactly as given (the model is told to keep the keys, but a stray
  // extra/renamed key must never land on the wrong variant).
  const variantImages = {};
  if (wantsVariants) {
    const returned = parsed.variantImages && typeof parsed.variantImages === "object" ? parsed.variantImages : {};
    for (const v of variantValues) {
      const url = returned[v];
      variantImages[v] = typeof url === "string" && url.startsWith("http") ? url : null;
    }
  }

  // imageUrl: for a single-variant product, its photo; for a multi-variant
  // one, a product-level main photo only (productImportDrain.js never
  // assigns it to a variant — see fallbackImageUrl there).
  const wantsAnyImage = needsImage || wantsVariants;
  const imageUrl = wantsAnyImage && typeof parsed.imageUrl === "string" && parsed.imageUrl.startsWith("http") ? parsed.imageUrl : null;

  return {
    specs: parsed.specs || null,
    imageUrl,
    variantImages,
    sourceNotes: parsed.sourceNotes || (response.stop_reason === "refusal" ? "declined" : null),
    model: MODEL,
    usage,
    cost: modelConfig.computeCost(MODEL, usage),
  };
}

module.exports = { researchProductSpecs };
