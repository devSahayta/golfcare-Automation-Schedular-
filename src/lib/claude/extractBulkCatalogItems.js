// src/lib/claude/extractBulkCatalogItems.js
//
// Module 6.x — the actual catalog-parsing step for bulk product import.
// Deliberately NOT asked of the live conversational model: confirmed live,
// twice, that trying to get the supplier agent to transcribe a ~100-item
// catalog into a tool call fails against toolLoop.js's shared 1024-token
// response cap and the turn's overall iteration cap, no matter how the
// chunking is instructed. This runs as its own isolated call instead (same
// "separate from the main loop" pattern as researchProductSpecs.js /
// draftDynamicTemplate.js), with no shared budget to fight over.
//
// The raw document text itself is split into character-bounded segments
// (not item-bounded — the caller has no idea where item boundaries are
// before parsing) so this scales to a document of any size: a bigger
// catalog just means more segments and more (still isolated, still
// unbounded) calls, never a single call trying to hold the whole thing.

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-4-6";
const SONNET_RATE = { inputPerMtok: 3, outputPerMtok: 15 };
const USD_TO_INR = 95;
const SEGMENT_CHARS = 6000;
const MAX_OUTPUT_TOKENS = 8192;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are extracting a structured product list from a raw, messy price-catalog document (text extracted from a PDF — spacing and line breaks may be imperfect).

Respond with ONLY a JSON array, no other text, no markdown code fences:
[{"title": "...", "mrp": 1234, "sku": "..." or null, "brand": "..." or null}, ...]

Rules:
- Include every row that names a real product AND gives it an explicit price (MRP/price in INR). Skip anything with no price — section headers, brand intro text, "thank you" pages, decorative-only lines.
- title: a clear, specific product name — combine the product name with its color/variant name if the document gives one as a separate word (e.g. "Adidas Reversible Webbing Belt - Navy"), so each distinct article number becomes its own clearly-named item.
- mrp: the number only, no currency symbols or commas. If a price looks obviously corrupted (e.g. "8GG0" where digits got OCR'd into letters), use your best real-world judgement to correct an obvious single-character OCR slip (e.g. "8GG0" -> 8990 is NOT a safe guess — in that case instead set mrp to null and leave it out of the array entirely; never invent a number you can't actually read).
- sku: the article/SKU/product code exactly as given, if any.
- brand: the manufacturer/brand name, if identifiable from context (a section header naming the brand applies to the rows under it).
- If several color/article variants of the same product share one line with one price, create one item per article number, not one item for the whole line.
- Never include a row twice.

If the text segment has no genuine priced product rows at all (e.g. it's pure section-header/thank-you boilerplate), respond with an empty array: []`;

function splitIntoSegments(text) {
  const segments = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SEGMENT_CHARS) {
      segments.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", SEGMENT_CHARS);
    if (cut <= 0) cut = SEGMENT_CHARS;
    segments.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return segments;
}

function parseSegmentResponse(text) {
  const cleaned = (text || "")
    .replace(/^```(json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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
 * @param {string} input.documentText
 * @returns {Promise<{items: {title:string, mrp:number, sku:string|null, brand:string|null}[], usage: {inputTokens:number, outputTokens:number}, cost: {usd:number, inr:number}, segmentCount: number}>}
 */
async function extractBulkCatalogItems({ documentText }) {
  const segments = splitIntoSegments(documentText || "");
  let items = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (const segment of segments) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: segment }],
    });
    inputTokens += response.usage?.input_tokens || 0;
    outputTokens += response.usage?.output_tokens || 0;

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const segmentItems = parseSegmentResponse(text)
      .filter((i) => i?.title && i.mrp != null && !Number.isNaN(Number(i.mrp)));
    items = items.concat(segmentItems);
  }

  const usage = { inputTokens, outputTokens };
  return { items, usage, cost: computeCost(usage), segmentCount: segments.length };
}

module.exports = { extractBulkCatalogItems };
