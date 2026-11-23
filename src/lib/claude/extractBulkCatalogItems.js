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
const { VOCABULARY } = require("../shopifyTaxonomy");

const MODEL = "claude-sonnet-4-6";
const SONNET_RATE = { inputPerMtok: 3, outputPerMtok: 15 };
const USD_TO_INR = 95;
const SEGMENT_CHARS = 6000; // legacy text-only path only
const PAGES_PER_SEGMENT = Number(process.env.PRODUCT_IMPORT_PAGES_PER_SEGMENT) || 3;
// Tuned so a typical row-batch's worth of distinct products comfortably
// produces JSON under MAX_OUTPUT_TOKENS — same reasoning PAGES_PER_SEGMENT
// documents for PDFs, just in "rows" instead of "pages." Confirmed against
// a real 1,352-row supplier sheet (xlsxRowExtractor.js) that this leaves
// headroom even on its densest sections.
const ROWS_PER_SEGMENT = Number(process.env.PRODUCT_IMPORT_ROWS_PER_SEGMENT) || 150;
const MAX_OUTPUT_TOKENS = 8192;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PRODUCT_TYPE_VOCABULARY = VOCABULARY.map(([type]) => type).join(", ");

const SYSTEM_PROMPT = `You are extracting a structured product list from a raw price-catalog document — either messy text extracted from a PDF (spacing and line breaks may be imperfect), or rows from a supplier's own spreadsheet (pipe-separated cell values, one row per line). Some of what you're shown also includes the document's own real product photos, each clearly labeled with the page and an image index it belongs to (e.g. "[Page 3, Image 0]") — use those when deciding each variant's documentImageIndex.

Respond with ONLY a JSON array, no other text, no markdown code fences:
[{"title": "...", "brand": "..." or null, "category": "..." or null, "productType": "..." or null, "variantOptionName": "Color" or "Size" or null, "variants": [{"value": "..." or null, "sku": "..." or null, "mrp": 1234, "quantity": 10 or null, "documentImageIndex": 0 or null}]}, ...]

Rules:
- One array entry = ONE PRODUCT, which may have several real variants (color/size) — NOT one entry per SKU/article number. If the SAME base product appears multiple times differing only by color or size (e.g. a belt listed 4 times, same name, different article number per color), that is ONE entry with 4 entries in its "variants" array — do not create 4 separate products for it.
- title: the base product name only — no color/size baked in (that belongs in each variant's "value", not the title).
- category: a short general product-type label inferred from the document's own structure — usually a section heading (e.g. "Bags", "Headwear", "Apparel", "Accessories", "Balls", "Gloves"). Keep it short and generic (a type of product, not a specific model name); null if genuinely not inferable.
- productType: pick the CLOSEST match from this store's real existing product types: ${PRODUCT_TYPE_VOCABULARY}. This store has its own conventions that don't always match what you'd guess — e.g. a polo shirt is classified "T-Shirts" here, not "Polos"; pants are "Trousers", not "Pants". Match by what the product actually IS, not by the document's own wording. If genuinely nothing in that list fits well, use your own short, specific, Title Case label instead (e.g. "Rain Jackets") rather than forcing a bad match — never leave it null just because nothing in the list fits exactly; only use null if you can't tell what kind of product this even is.
- variantOptionName: the ONE dimension that distinguishes the variants ("Color" or "Size" are the common cases) — null if the product has only one variant (variants array will have exactly 1 entry, with value: null).
- Each entry in variants needs its own mrp. value is the color/size word for that variant (null if variantOptionName is null). sku is that specific variant's own article/SKU/product code if the document gives one, else null — do NOT invent or share a SKU across variants that don't each have their own in the source text.
- quantity: if the document states a stock count / quantity-in-hand / qty-available number for this specific variant (separate from its price and from its SKU/article number), extract it as a plain integer. null if the document doesn't give one — never confuse it with price, a SKU, or a size-range listing; never guess or invent a number that isn't actually printed as a quantity.
- documentImageIndex: if you were shown real product photos for this page and one of them is CONFIDENTLY this specific variant's own photo (not a logo, not a banner, not a different variant's photo, not just "a photo from this page"), set it to that image's index. If you weren't shown any images, aren't confident which photo (if any) is this variant's, or the page's images are all decorative (brand logos, section dividers, cover/thank-you slides), set it to null — never guess. When a page shows several colors of one product, match each color to its OWN best photo, not the same index for all of them. When a page shows several angle-shots of a single-variant product, pick the one clearest index for that one variant.
- If the document gives sizes as a RANGE shared by one article/color (e.g. "S M L XL 2XL" after one price and one SKU) rather than a distinct SKU per size, that's still effectively ONE variant for extraction purposes — set variantOptionName to null and variants to a single entry (the per-size breakdown isn't capturable from a shared SKU+price and would need a human to add real size variants later).
- Include every row/group that names a real product AND gives it an explicit price (MRP/price in INR). Skip anything with no price — section headers, brand intro text, "thank you" pages, decorative-only lines.
- mrp: the number only, no currency symbols or commas. If a price looks obviously corrupted (e.g. "8GG0" where digits got OCR'd into letters), never guess the real number — instead drop that one variant (or the whole product if it's the only variant) rather than inventing a figure.
- brand: the manufacturer/brand name, if identifiable from context (a section header naming the brand applies to the rows under it — including a brand shown only as a logo/wordmark image, with no brand text on the page at all, if you can read it in the image). You may also be given a "Carried-forward brand" note — the last brand established by an earlier page's own header/logo elsewhere in this same document, since a long brand section commonly doesn't repeat its name on every single page. Use it for rows on a page that shows no brand, header, or logo of its own. The moment a page in front of you shows a different or new brand's own header/logo/text, that overrides the carried-forward note — never let it override what's actually on the page.
- Never include the same variant twice.
- If you're shown a spreadsheet header line (the first line, naming each pipe-separated column), use it to know what each column actually means instead of guessing from position alone. A cell combining a code and a name in one value, e.g. "BB912730 (BB MOBILE DEVICE HOLDER)", splits into that variant's own sku ("BB912730") and the product's title ("BB MOBILE DEVICE HOLDER") — the parenthesized part is the human-readable name, the leading code is the sku, never keep them smashed together in title.

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

function splitIntoRowBatches(rows) {
  const batches = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_SEGMENT) {
    batches.push(rows.slice(i, i + ROWS_PER_SEGMENT));
  }
  return batches;
}

// Unlike buildPageBatchContent, there's no carry-forward-brand note and no
// image blocks — a spreadsheet row states its own brand inline (confirmed
// against a real supplier sheet: every single row has its own BRAND cell,
// no section-divider-only brand signal the way a PDF's pages can have), so
// none of that machinery applies here. The header line is repeated into
// EVERY batch (not just the first, the way it'd naturally land if this
// sheet were just character-split) so every call knows what each column
// means.
function buildRowBatchContent(headerLine, rowBatch) {
  const lines = headerLine ? [headerLine, ...rowBatch] : rowBatch;
  return [{ type: "text", text: lines.join("\n") }];
}

// Builds one page-batch's message content: alternating text/image blocks,
// each image immediately preceded by a short label naming its page+index
// so the model can cite it back in documentImageIndex. Images are sent as
// base64 (bytes already in hand from pdfImageExtractor.js) rather than
// fetched by URL — simpler and avoids any inconsistency across SDK
// versions in URL-sourced image blocks.
function buildPageBatchContent(pageBatch, carryForwardBrand) {
  const content = [];
  if (carryForwardBrand) {
    content.push({
      type: "text",
      text: `Carried-forward brand: "${carryForwardBrand}" — the last brand established by an earlier page's own header/logo in this document. See the brand rule above for when to use it.`,
    });
  }
  for (const page of pageBatch) {
    if (page.skippedNonJpeg > 0) {
      // Confirmed live: a brand-divider page whose only brand signal is a
      // stylized logo in a format pdfImageExtractor.js can't decode (v1 is
      // JPEG-only) was silently invisible to the model, which then applied
      // the stale carried-forward brand from the PRIOR section to this
      // page's own products within this very call — mislabeling a whole
      // new brand's items as the old one. This note makes that gap visible
      // to the model instead of letting it default to "no new signal, so
      // keep the old brand."
      content.push({
        type: "text",
        text: `Note: page ${page.pageNumber} contains ${page.skippedNonJpeg} image(s) this system could not display (unsupported format — commonly a stylized brand logo/wordmark on a section-divider page). If this page's own text doesn't name a brand, do NOT assume the carried-forward brand noted above still applies here or on pages after it — treat the brand as unknown until it's actually confirmed in text or a displayable image.`,
      });
    }
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
  } catch (err) {
    console.warn(`[extractBulkCatalogItems] failed to parse segment response as JSON (${err.message}) — treating as empty`);
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((p) => ({
      title: p?.title,
      brand: p?.brand || null,
      category: p?.category || null,
      productType: p?.productType || null,
      variantOptionName: p?.variantOptionName || null,
      variants: (Array.isArray(p?.variants) ? p.variants : [])
        .filter((v) => v?.mrp != null && !Number.isNaN(Number(v.mrp)))
        .map((v) => ({
          value: v.value || null,
          sku: v.sku || null,
          mrp: Number(v.mrp),
          quantity: v.quantity != null && !Number.isNaN(Number(v.quantity)) ? Number(v.quantity) : null,
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
    truncated: response.stop_reason === "max_tokens",
  };
}

// A page-batch whose response got cut off by MAX_OUTPUT_TOKENS mid-JSON
// fails parseSegmentResponse's JSON.parse and silently becomes an empty
// array — indistinguishable from "this page genuinely has nothing", so a
// dense multi-brand page-batch (several products, each with photo-matched
// variants) can lose everything in that batch at once with zero signal.
// Confirmed live: the final 3-page segment of a 105-page catalog, bundling
// two unusually dense brand pages, came back completely empty this way.
// Retried here by halving the page-batch and re-running each half as its
// own call — cheaper pages fit comfortably under the cap on their own, and
// re-running with fewer pages is the only lever available since the
// response size is driven by how much is ON the page, not anything tunable
// per call. Bottoms out at single pages; a single page that still
// truncates is logged and returned as-is (best-effort partial parse) since
// there's nothing smaller left to retry with.
async function runPageBatchWithRetry(pageBatch, carryForwardBrand) {
  const result = await runSegment(buildPageBatchContent(pageBatch, carryForwardBrand));
  if (!result.truncated || pageBatch.length === 1) {
    if (result.truncated) {
      console.warn(
        `[extractBulkCatalogItems] page ${pageBatch[0].pageNumber} alone hit max_tokens — response may be incomplete, using what parsed`,
      );
    }
    return result;
  }

  const mid = Math.ceil(pageBatch.length / 2);
  const halves = [pageBatch.slice(0, mid), pageBatch.slice(mid)];
  console.warn(
    `[extractBulkCatalogItems] segment for pages ${pageBatch.map((p) => p.pageNumber).join(",")} hit max_tokens — retrying as ${halves.map((h) => h.map((p) => p.pageNumber).join("+")).join(" and ")}`,
  );

  let items = [];
  let inputTokens = result.inputTokens;
  let outputTokens = result.outputTokens;
  let brand = carryForwardBrand;
  for (const half of halves) {
    const sub = await runPageBatchWithRetry(half, brand);
    items = items.concat(sub.items);
    inputTokens += sub.inputTokens;
    outputTokens += sub.outputTokens;
    const lastBrand = [...sub.items].reverse().find((it) => it.brand)?.brand;
    if (lastBrand) brand = lastBrand;
  }
  return { items, inputTokens, outputTokens, truncated: false };
}

// Same truncation-halving shape as runPageBatchWithRetry, for a row-batch
// instead of a page-batch — no carry-forward-brand to thread through (see
// buildRowBatchContent's own comment for why).
async function runRowBatchWithRetry(headerLine, rowBatch) {
  const result = await runSegment(buildRowBatchContent(headerLine, rowBatch));
  if (!result.truncated || rowBatch.length === 1) {
    if (result.truncated) {
      console.warn(
        `[extractBulkCatalogItems] a single row alone hit max_tokens — response may be incomplete, using what parsed: "${rowBatch[0]?.slice(0, 120)}"`,
      );
    }
    return result;
  }

  const mid = Math.ceil(rowBatch.length / 2);
  const halves = [rowBatch.slice(0, mid), rowBatch.slice(mid)];
  console.warn(
    `[extractBulkCatalogItems] row-batch of ${rowBatch.length} hit max_tokens — retrying as ${halves.map((h) => h.length).join(" + ")} rows`,
  );

  let items = [];
  let inputTokens = result.inputTokens;
  let outputTokens = result.outputTokens;
  for (const half of halves) {
    const sub = await runRowBatchWithRetry(headerLine, half);
    items = items.concat(sub.items);
    inputTokens += sub.inputTokens;
    outputTokens += sub.outputTokens;
  }
  return { items, inputTokens, outputTokens, truncated: false };
}

// Same truncation-halving safety net applied to the legacy plain-text
// segment path (documentText mode) — previously called runSegment()
// directly with no retry at all, a real pre-existing gap: a dense enough
// character-bounded segment can truncate exactly like a dense page-batch
// or row-batch already could, and would silently drop whatever was in it.
// Halves by splitting the segment's text at a newline near its midpoint
// (falls back to a hard character split if the segment has no newline
// near the middle — same fallback splitIntoCharSegments itself already
// uses).
async function runTextSegmentWithRetry(segmentText) {
  const result = await runSegment(segmentText);
  if (!result.truncated || segmentText.length < 200) {
    if (result.truncated) {
      console.warn(
        `[extractBulkCatalogItems] a short text segment alone hit max_tokens — response may be incomplete, using what parsed`,
      );
    }
    return result;
  }

  const mid = Math.floor(segmentText.length / 2);
  let cut = segmentText.lastIndexOf("\n", mid);
  if (cut <= 0) cut = mid;
  const halves = [segmentText.slice(0, cut), segmentText.slice(cut)];
  console.warn(
    `[extractBulkCatalogItems] text segment (${segmentText.length} chars) hit max_tokens — retrying as ${halves.map((h) => h.length).join(" + ")} chars`,
  );

  let items = [];
  let inputTokens = result.inputTokens;
  let outputTokens = result.outputTokens;
  for (const half of halves) {
    const sub = await runTextSegmentWithRetry(half);
    items = items.concat(sub.items);
    inputTokens += sub.inputTokens;
    outputTokens += sub.outputTokens;
  }
  return { items, inputTokens, outputTokens, truncated: false };
}

/**
 * @param {object} input
 * @param {string} [input.headerLine]
 * @param {string[]} [input.rows]
 *        Row-aware mode (xlsxRowExtractor.js) — a supplier spreadsheet's
 *        full, untruncated data rows, batched ROWS_PER_SEGMENT at a time
 *        with headerLine repeated into every batch. Checked first; when
 *        `rows` is a non-empty array, `pages`/`documentText` are ignored.
 * @param {{pageNumber:number, text:string, images:{index:number, mimeType?:string, bytes:Buffer}[], skippedNonJpeg?:number}[]} [input.pages]
 *        Page-aware mode — each returned variant's documentImageIndex refers
 *        to a page-local image index the CALLER must resolve back to a real
 *        URL (via the same page's `images` list) — this function never sees
 *        or returns URLs, only bytes in and indices out.
 * @param {string} [input.documentText]
 *        Legacy text-only mode, used only when neither `rows` nor `pages` is given.
 * @returns {Promise<{items: {title:string, brand:string|null, category:string|null, productType:string|null, variantOptionName:string|null, variants:{value:string|null, sku:string|null, mrp:number, quantity:number|null, documentImageIndex:number|null}[]}[], usage: {inputTokens:number, outputTokens:number}, cost: {usd:number, inr:number}, segmentCount: number}>}
 */
async function extractBulkCatalogItems({ headerLine, rows, pages, documentText }) {
  const rowBatches = Array.isArray(rows) && rows.length > 0 ? splitIntoRowBatches(rows) : null;
  const segments = !rowBatches && Array.isArray(pages) && pages.length > 0 ? splitIntoPageBatches(pages) : null;

  let items = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let segmentCount = 0;

  if (rowBatches) {
    for (const rowBatch of rowBatches) {
      const result = await runRowBatchWithRetry(headerLine, rowBatch);
      items = items.concat(result.items);
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      segmentCount++;
    }
  } else if (segments) {
    // Each page-batch is its own isolated API call with no memory of any
    // other batch — confirmed live: a brand named once on a section divider
    // page (sometimes only as a logo image, no brand text at all) can head
    // a run of 20+ product pages that never repeat it, spanning several
    // batches at PAGES_PER_SEGMENT=3. Only the one batch containing the
    // divider itself would ever see the brand without this. carryForwardBrand
    // is sticky across batches — it only updates when a batch's own items
    // actually came back branded, so a batch of brand-less rows (or one the
    // model missed) doesn't reset it, and a genuinely new section's brand
    // naturally takes over once the model reads it off that section's own
    // pages.
    let carryForwardBrand = null;
    for (const pageBatch of segments) {
      const result = await runPageBatchWithRetry(pageBatch, carryForwardBrand);
      items = items.concat(result.items);
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      segmentCount++;
      const lastBrand = [...result.items].reverse().find((it) => it.brand)?.brand;
      if (lastBrand) {
        carryForwardBrand = lastBrand;
      } else if (result.items.length === 0 && pageBatch.some((p) => (p.skippedNonJpeg || 0) > 0)) {
        // This batch had an image we couldn't decode (pdfImageExtractor is
        // JPEG-only — a non-JPEG logo on what's likely a brand-divider page)
        // and returned no priced rows of its own. Go in unknown for the next
        // batch rather than keep asserting the OLD section's brand onto
        // whatever a new, unreadable-logo'd section turns out to be —
        // confirmed live: without this, a stale brand from several segments
        // back silently mislabeled an entire new brand's products. If the
        // supplier named this document's brand in chat, batch.defaultBrand
        // (applied downstream in productImportDrain.js) covers the gap this
        // leaves; it's a safer fallback than a confidently wrong carry-over.
        carryForwardBrand = null;
      }
    }
  } else {
    const textSegments = splitIntoCharSegments(documentText || "");
    for (const segment of textSegments) {
      const result = await runTextSegmentWithRetry(segment);
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
