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
// Two call shapes, same underlying machinery:
//   - page-aware (`pages` given): each Claude call covers a few consecutive
//     PDF pages, carrying both that page's text AND its real embedded
//     product photos (pdfImageExtractor.js, extractPendingBatch — already
//     uploaded to Supabase Storage by the time this runs) as vision content
//     blocks. Lets the model assign a real document photo to the right
//     product/variant instead of every new item needing a separate (and
//     sometimes wrong) web-image search later. This is the normal path —
//     every batch created after sourceMediaUrl shipped goes through it.
//   - legacy text-only (`documentText` given, no `pages`): the original
//     character-bounded-segment behavior, kept only for batches already
//     sitting PENDING_EXTRACTION without a sourceMediaUrl at deploy time —
//     not reachable for any batch created going forward. No image handling
//     at all in this path; every variant comes back with
//     documentImageIndex: null, which the drain job treats as "nothing to
//     resolve, fall through to web research" exactly like it always has.
//
// Returns one entry per real PRODUCT (which may bundle several variants —
// e.g. a belt in 4 colors is ONE entry with a 4-item variants array), not
// one entry per SKU, so a genuinely new product with multiple variants
// becomes one real Shopify product with real variants, not several
// separate single-variant products.

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-4-6";
const SONNET_RATE = { inputPerMtok: 3, outputPerMtok: 15 };
const USD_TO_INR = 95;
const SEGMENT_CHARS = 6000; // legacy text-only path only
const PAGES_PER_SEGMENT = Number(process.env.PRODUCT_IMPORT_PAGES_PER_SEGMENT) || 3;
const MAX_OUTPUT_TOKENS = 8192;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are extracting a structured product list from a raw, messy price-catalog document (text extracted from a PDF — spacing and line breaks may be imperfect). Some of what you're shown also includes the document's own real product photos, each clearly labeled with the page and an image index it belongs to (e.g. "[Page 3, Image 0]") — use those when deciding each variant's documentImageIndex.

Respond with ONLY a JSON array, no other text, no markdown code fences:
[{"title": "...", "brand": "..." or null, "category": "..." or null, "variantOptionName": "Color" or "Size" or null, "variants": [{"value": "..." or null, "sku": "..." or null, "mrp": 1234, "documentImageIndex": 0 or null}]}, ...]

Rules:
- One array entry = ONE PRODUCT, which may have several real variants (color/size) — NOT one entry per SKU/article number. If the SAME base product appears multiple times differing only by color or size (e.g. a belt listed 4 times, same name, different article number per color), that is ONE entry with 4 entries in its "variants" array — do not create 4 separate products for it.
- title: the base product name only — no color/size baked in (that belongs in each variant's "value", not the title).
- category: a short general product-type label inferred from the document's own structure — usually a section heading (e.g. "Bags", "Headwear", "Apparel", "Accessories", "Balls", "Gloves"). Keep it short and generic (a type of product, not a specific model name); null if genuinely not inferable.
- variantOptionName: the ONE dimension that distinguishes the variants ("Color" or "Size" are the common cases) — null if the product has only one variant (variants array will have exactly 1 entry, with value: null).
- Each entry in variants needs its own mrp. value is the color/size word for that variant (null if variantOptionName is null). sku is that specific variant's own article/SKU/product code if the document gives one, else null — do NOT invent or share a SKU across variants that don't each have their own in the source text.
- documentImageIndex: if you were shown real product photos for this page and one of them is CONFIDENTLY this specific variant's own photo (not a logo, not a banner, not a different variant's photo, not just "a photo from this page"), set it to that image's index. If you weren't shown any images, aren't confident which photo (if any) is this variant's, or the page's images are all decorative (brand logos, section dividers, cover/thank-you slides), set it to null — never guess. When a page shows several colors of one product, match each color to its OWN best photo, not the same index for all of them. When a page shows several angle-shots of a single-variant product, pick the one clearest index for that one variant.
- If the document gives sizes as a RANGE shared by one article/color (e.g. "S M L XL 2XL" after one price and one SKU) rather than a distinct SKU per size, that's still effectively ONE variant for extraction purposes — set variantOptionName to null and variants to a single entry (the per-size breakdown isn't capturable from a shared SKU+price and would need a human to add real size variants later).
- Include every row/group that names a real product AND gives it an explicit price (MRP/price in INR). Skip anything with no price — section headers, brand intro text, "thank you" pages, decorative-only lines.
- mrp: the number only, no currency symbols or commas. If a price looks obviously corrupted (e.g. "8GG0" where digits got OCR'd into letters), never guess the real number — instead drop that one variant (or the whole product if it's the only variant) rather than inventing a figure.
- brand: the manufacturer/brand name, if identifiable from context (a section header naming the brand applies to the rows under it).
- Never include the same variant twice.

If the text segment has no genuine priced product rows at all (e.g. it's pure section-header/thank-you boilerplate), respond with an empty array: []`;

function splitIntoCharSegments(text) {
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

function splitIntoPageBatches(pages) {
  const batches = [];
  for (let i = 0; i < pages.length; i += PAGES_PER_SEGMENT) {
    batches.push(pages.slice(i, i + PAGES_PER_SEGMENT));
  }
  return batches;
}

// Builds one page-batch's message content: alternating text/image blocks,
// each image immediately preceded by a short label naming its page+index
// so the model can cite it back in documentImageIndex. Images are sent as
// base64 (bytes already in hand from pdfImageExtractor.js) rather than
// fetched by URL — simpler and avoids any inconsistency across SDK
// versions in URL-sourced image blocks.
function buildPageBatchContent(pageBatch) {
  const content = [];
  for (const page of pageBatch) {
    content.push({
      type: "text",
      text: `--- PAGE ${page.pageNumber} ---\n${page.text}`,
    });
    for (const img of page.images) {
      content.push({
        type: "text",
        text: `[Page ${page.pageNumber}, Image ${img.index}]`,
      });
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mimeType || "image/jpeg", data: img.bytes.toString("base64") },
      });
    }
  }
  return content;
}

function parseSegmentResponse(text) {
  const cleaned = (text || "")
    .replace(/^```(json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((p) => ({
      title: p?.title,
      brand: p?.brand || null,
      category: p?.category || null,
      variantOptionName: p?.variantOptionName || null,
      variants: (Array.isArray(p?.variants) ? p.variants : [])
        .filter((v) => v?.mrp != null && !Number.isNaN(Number(v.mrp)))
        .map((v) => ({
          value: v.value || null,
          sku: v.sku || null,
          mrp: Number(v.mrp),
          documentImageIndex: Number.isInteger(v.documentImageIndex) ? v.documentImageIndex : null,
        })),
    }))
    .filter((p) => p.title && p.variants.length > 0);
}

function computeCost(usage) {
  const usd =
    (usage.inputTokens / 1_000_000) * SONNET_RATE.inputPerMtok +
    (usage.outputTokens / 1_000_000) * SONNET_RATE.outputPerMtok;
  return { usd, inr: usd * USD_TO_INR };
}

async function runSegment(content) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return {
    items: parseSegmentResponse(text),
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
  };
}

/**
 * @param {object} input
 * @param {{pageNumber:number, text:string, images:{index:number, mimeType?:string, bytes:Buffer}[]}[]} [input.pages]
 *        Page-aware mode — each returned variant's documentImageIndex refers
 *        to a page-local image index the CALLER must resolve back to a real
 *        URL (via the same page's `images` list) — this function never sees
 *        or returns URLs, only bytes in and indices out.
 * @param {string} [input.documentText]
 *        Legacy text-only mode, used only when `pages` isn't given.
 * @returns {Promise<{items: {title:string, brand:string|null, category:string|null, variantOptionName:string|null, variants:{value:string|null, sku:string|null, mrp:number, documentImageIndex:number|null}[]}[], usage: {inputTokens:number, outputTokens:number}, cost: {usd:number, inr:number}, segmentCount: number}>}
 */
async function extractBulkCatalogItems({ pages, documentText }) {
  const segments = Array.isArray(pages) && pages.length > 0 ? splitIntoPageBatches(pages) : null;

  let items = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let segmentCount = 0;

  if (segments) {
    for (const pageBatch of segments) {
      const content = buildPageBatchContent(pageBatch);
      const result = await runSegment(content);
      items = items.concat(result.items);
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      segmentCount++;
    }
  } else {
    const textSegments = splitIntoCharSegments(documentText || "");
    for (const segment of textSegments) {
      const result = await runSegment(segment);
      items = items.concat(result.items);
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      segmentCount++;
    }
  }

  const usage = { inputTokens, outputTokens };
  return { items, usage, cost: computeCost(usage), segmentCount };
}

module.exports = { extractBulkCatalogItems };
