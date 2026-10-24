// src/jobs/productImportDrain.js
//
// Drains ProductImportItem rows queued by golfcare-backend's
// start_bulk_product_import tool (supplierAgentTools.js) — a supplier
// sending a large new-product catalog/price list (hundreds of items) in
// one WhatsApp message can't be processed inline during that chat turn:
// each item potentially needs a Claude web-search research call plus
// 2-3 real Shopify Admin API calls, which would blow well past a Vercel
// function's timeout and Shopify's ~2 req/sec rate limit if attempted in
// one request. This job does the same per-item work
// (findExistingCatalogMatch -> researchProductSpecs -> createDraftProduct
// -> ProductDraft) gradually, from a process with no request-timeout
// ceiling — same isRunning-guard + small-batch + sequential-paced pattern
// as shopifySyncQueueDrain.js, for the same reason (pacing by item, not
// bounded concurrency, since each item itself is several sequential API
// calls, not one).
//
// Approval emails are NOT sent per item (hundreds would flood the staff
// inbox, same reasoning as the backend's SUPPLIER_BULK_NEW_PRODUCT_LIMIT
// cap on the one-by-one flow) — one digest email per finished batch
// instead, listing every drafted item's individual review link (there's
// no bulk-review frontend yet, so the link list is the only way to
// actually approve them until that's built).

const cron = require("node-cron");
const crypto = require("crypto");
const axios = require("axios");
const { prisma } = require("../lib/prisma");
const { setAvailability } = require("../services/availabilityService");
const { findExistingCatalogMatch, findPendingDraftMatch } = require("../lib/productCatalogMatch");
const { broadTagFor } = require("../lib/shopifyTaxonomy");
const { researchProductSpecs, researchVariantImage } = require("../lib/claude/researchProductSpecs");
const { extractBulkCatalogItems } = require("../lib/claude/extractBulkCatalogItems");
const { extractPdfPagesWithImages } = require("../lib/pdfImageExtractor");
const { uploadDocumentImage } = require("../lib/supabaseStorage");
const { createDraftProduct, addVariantImage } = require("../lib/shopify");
const { updateInventoryItemCost } = require("../lib/shopifyInventory");
const { computeCostPrice } = require("../lib/pricingCalculator");
const { sendBulkImportDigestEmail } = require("../lib/email/sendBulkImportDigestEmail");
const { sendBulkImportCompletionMessage } = require("../lib/sendBulkImportCompletionMessage");

const BATCH_SIZE = Number(process.env.PRODUCT_IMPORT_BATCH_SIZE || 5);
const PACE_MS = Number(process.env.PRODUCT_IMPORT_PACE_MS || 2000);
const TOKEN_EXPIRY_DAYS = Number(process.env.PRODUCT_DRAFT_TOKEN_EXPIRY_DAYS || 7);
// Sane upper bound on one document's extraction — a guard against a
// garbled/duplicated extraction producing an absurd item count, not a
// real business limit.
const MAX_ITEMS_PER_BATCH = Number(process.env.BULK_PRODUCT_IMPORT_MAX_ITEMS || 1000);

function normalizeRateKey(s) {
  return (s || "").toLowerCase().trim();
}

// true if ruleVal doesn't filter on this dimension, or if it fuzzily
// matches itemVal. False (never a match) when the rule DOES filter on
// this dimension but the item's own value is unknown (null) — a rule
// should never apply to something it can't actually confirm.
function fuzzyFieldMatch(ruleVal, itemVal) {
  if (!ruleVal) return true;
  if (!itemVal) return false;
  const a = normalizeRateKey(ruleVal);
  const b = normalizeRateKey(itemVal);
  return a === b || a.includes(b) || b.includes(a);
}

// Resolves one extracted item's margin/GST against the batch's rateRules
// — the supplier's actual given rates, never a guess (see
// start_bulk_product_import's tool description, backend repo). Picks the
// MOST SPECIFIC matching rule (brand+category beats either alone beats
// a bare default with neither set); returns null if nothing matches, in
// which case the caller marks the item NEEDS_RATE instead of drafting it
// with an invented number.
function resolveRate(rateRules, item) {
  const rules = Array.isArray(rateRules) ? rateRules : [];
  let best = null;
  let bestSpecificity = -1;
  for (const rule of rules) {
    if (!fuzzyFieldMatch(rule.brand, item.brand)) continue;
    if (!fuzzyFieldMatch(rule.category, item.category)) continue;
    const specificity = (rule.brand ? 1 : 0) + (rule.category ? 1 : 0);
    if (specificity > bestSpecificity) {
      best = rule;
      bestSpecificity = specificity;
    }
  }
  return best ? { marginPercent: best.marginPercent, gstPercent: best.gstPercent } : null;
}

// Re-fetches the original PDF (sourceMediaUrl, set at batch-creation time
// by backend's start_bulk_product_import) and pulls its embedded product
// photos + per-page text (pdfImageExtractor.js), uploading each DISTINCT
// image exactly once (by content hash — a repeated logo/banner across many
// pages shouldn't become many uploads) to Supabase Storage. Images are
// renumbered with a GLOBALLY unique index across the whole document before
// being handed to extractBulkCatalogItems — a per-page-local index (0, 1,
// 2...) would collide across pages once several pages' images land in the
// same Claude call (page-batched, see PAGES_PER_SEGMENT), so there'd be no
// way to tell "page 1's image 0" from "page 4's image 0" apart when
// resolving documentImageIndex back to a real URL afterward.
async function extractPagesWithUploadedImages(batch) {
  const pdfRes = await axios.get(batch.sourceMediaUrl, { responseType: "arraybuffer" });
  const pdfBuffer = Buffer.from(pdfRes.data);
  const { pages, skippedNonJpegImageCount } = await extractPdfPagesWithImages(pdfBuffer);

  const hashToGlobalIndex = new Map();
  const globalIndexToUrl = new Map();
  let nextGlobalIndex = 0;
  const pagesForExtraction = [];

  for (const page of pages) {
    const renumberedImages = [];
    for (const img of page.images) {
      let globalIndex = hashToGlobalIndex.get(img.contentHash);
      if (globalIndex === undefined) {
        globalIndex = nextGlobalIndex++;
        hashToGlobalIndex.set(img.contentHash, globalIndex);
        const url = await uploadDocumentImage(img.bytes, `batch-${batch.id}-img-${globalIndex}.jpg`);
        globalIndexToUrl.set(globalIndex, url);
      }
      renumberedImages.push({ index: globalIndex, mimeType: img.mimeType, bytes: img.bytes });
    }
    pagesForExtraction.push({ pageNumber: page.pageNumber, text: page.text, images: renumberedImages });
  }

  if (skippedNonJpegImageCount > 0) {
    console.log(
      `[job] productImportDrain: batch ${batch.id} had ${skippedNonJpegImageCount} non-JPEG embedded image(s) that couldn't be extracted (v1 is JPEG/DCTDecode only).`,
    );
  }

  return { pagesForExtraction, globalIndexToUrl };
}

// Parses one PENDING_EXTRACTION batch's raw document text (and, when
// sourceMediaUrl is set, its real embedded product photos) into real
// ProductImportItem rows, then flips it to PROCESSING so the normal
// draining loop below picks it up exactly like any other batch. One
// batch per tick — a genuinely huge document's extraction (several
// Claude calls, see extractBulkCatalogItems.js) can take a while, and
// there's no reason to block that tick on more than one.
async function extractPendingBatch() {
  const batch = await prisma.productImportBatch.findFirst({
    where: { status: "PENDING_EXTRACTION" },
    orderBy: { createdAt: "asc" },
  });
  if (!batch) return null;

  try {
    let rawResult;
    let globalIndexToUrl = new Map();

    // No sourceMediaUrl means this batch predates the feature — falls back
    // to the original text-only path untouched, not a backfill target.
    if (batch.sourceMediaUrl) {
      const prepared = await extractPagesWithUploadedImages(batch);
      globalIndexToUrl = prepared.globalIndexToUrl;
      rawResult = await extractBulkCatalogItems({ pages: prepared.pagesForExtraction });
    } else {
      rawResult = await extractBulkCatalogItems({ documentText: batch.rawDocumentText || "" });
    }

    // Resolve each variant's documentImageIndex (meaningless outside this
    // function — a global index into globalIndexToUrl, nothing else knows
    // what to do with it) into a real documentImageUrl, or null when there
    // wasn't a confident match (legacy text-only path: always null here,
    // same as every variant always has been until this feature existed).
    const items = rawResult.items.map((it) => ({
      ...it,
      variants: it.variants.map((v) => ({
        value: v.value,
        sku: v.sku,
        mrp: v.mrp,
        documentImageUrl: v.documentImageIndex != null ? globalIndexToUrl.get(v.documentImageIndex) || null : null,
      })),
    }));
    const { usage, cost, segmentCount } = rawResult;

    if (batch.conversationId) {
      try {
        await prisma.agentUsage.create({
          data: {
            conversationId: batch.conversationId,
            productImportBatchId: batch.id,
            agentName: "SUPPLIER_BULK_IMPORT",
            model: "claude-sonnet-4-6",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: cost.usd,
            costInr: cost.inr,
            toolCallCount: segmentCount,
            outcome: items.length > 0 ? "extracted" : "no_items_found",
          },
        });
      } catch (err) {
        console.error(`[job] productImportDrain: AgentUsage log failed for batch ${batch.id} extraction:`, err.message);
      }
    }

    // Each extracted entry is one PRODUCT (possibly several real variants —
    // see extractBulkCatalogItems.js) — stored as one ProductImportItem row
    // with the full variant list in variantOptions, not one row per SKU.
    // Top-level sku/mrp mirror the first variant for simple display. Each
    // item's margin/GST are resolved against the batch's rateRules here,
    // once — nothing downstream (processItem, etc.) needs to know rates
    // ever varied by brand/category, it just reads the already-resolved
    // value off the row.
    const cleanItems = items
      .filter((i) => Array.isArray(i.variants) && i.variants.length > 0)
      .slice(0, MAX_ITEMS_PER_BATCH)
      .map((i) => {
        const rate = resolveRate(batch.rateRules, i);
        return {
          batchId: batch.id,
          title: i.title,
          sku: i.variants[0].sku || null,
          brand: i.brand || null,
          category: i.category || null,
          shopifyProductType: i.productType || null,
          mrp: i.variants[0].mrp,
          marginPercent: rate?.marginPercent ?? null,
          gstPercent: rate?.gstPercent ?? null,
          variantOptionName: i.variantOptionName || null,
          variantOptions: i.variants,
          status: rate ? "PENDING" : "NEEDS_RATE",
          // NEEDS_RATE items are already "done" from the drain loop's
          // perspective (it only ever queries PENDING) — processedAt now
          // marks that explicitly rather than leaving it looking stuck.
          processedAt: rate ? null : new Date(),
        };
      });

    if (cleanItems.length === 0) {
      await prisma.productImportBatch.update({
        where: { id: batch.id },
        data: { status: "DONE", completedAt: new Date(), extractionError: "No priced product rows found in document." },
      });
      return { batchId: batch.id, extracted: 0 };
    }

    const needsRateCount = cleanItems.filter((i) => i.status === "NEEDS_RATE").length;
    await prisma.productImportItem.createMany({ data: cleanItems });
    await prisma.productImportBatch.update({
      where: { id: batch.id },
      data: {
        totalItems: cleanItems.length,
        processedItems: needsRateCount,
        needsRateCount,
        status: "PROCESSING",
      },
    });
    // No-ops unless EVERY item came back NEEDS_RATE (nothing PENDING for
    // the normal drain loop to ever reach this batch through) — see
    // finalizeBatchIfComplete's own comment.
    await finalizeBatchIfComplete(batch.id);
    return { batchId: batch.id, extracted: cleanItems.length, needsRate: needsRateCount };
  } catch (err) {
    console.error(`[job] productImportDrain: extraction failed for batch ${batch.id}:`, err.message);
    await prisma.productImportBatch.update({
      where: { id: batch.id },
      data: { extractionError: String(err.message).slice(0, 500) },
    });
    return { batchId: batch.id, extracted: 0, failed: true };
  }
}

async function mapSequentialPaced(items, delayMs, fn) {
  for (let i = 0; i < items.length; i++) {
    await fn(items[i]);
    if (i < items.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// One item, start to finish: duplicate-check against the whole catalog
// (not just this supplier's known items — same "might not be new at all"
// reasoning as the backend's create_product_draft), and either link the
// existing product or research + create a real Shopify draft.
async function processItem(item, batch) {
  try {
    // item.variantOptions holds the real variant list (one entry per
    // Shopify variant this product should have) — see
    // extractBulkCatalogItems.js. Falls back to a single implied variant
    // (the item's own top-level sku/mrp) for a row that somehow has none,
    // which shouldn't happen from the extractor but keeps this function
    // from crashing if it ever does.
    const variants = Array.isArray(item.variantOptions) && item.variantOptions.length > 0
      ? item.variantOptions
      : [{ value: null, sku: item.sku, mrp: Number(item.mrp), documentImageUrl: null }];

    // Duplicate-check against the whole catalog, one probe per variant —
    // if ANY variant matches something that already exists, the simplest
    // safe call is to treat the WHOLE product as already-existing rather
    // than trying to split it into "these 2 variants are new, these 2
    // aren't" (that would mean adding variants to an existing live
    // Shopify product, a riskier operation this doesn't attempt). Known
    // simplification — rare in practice (a supplier catalog's items are
    // either all-new or all-already-stocked almost always).
    let catalogMatch = null;
    for (const v of variants) {
      catalogMatch = await findExistingCatalogMatch({
        title: item.title,
        sku: v.sku,
        variantOptions: item.variantOptionName && v.value ? [{ name: item.variantOptionName, value: v.value }] : [],
      });
      if (catalogMatch?.variant) break;
    }

    if (catalogMatch?.variant) {
      let supplierProduct = await prisma.supplierProduct.findFirst({
        where: { supplierId: batch.supplierId, variantId: catalogMatch.variant.id },
      });
      if (!supplierProduct) {
        supplierProduct = await prisma.supplierProduct.create({
          data: {
            supplierId: batch.supplierId,
            productId: catalogMatch.product.id,
            variantId: catalogMatch.variant.id,
            supplierSku: item.sku || null,
            isPrimary: true,
            marginPercent: item.marginPercent,
            gstPercent: item.gstPercent,
          },
        });
      }
      await prisma.supplierProduct.update({
        where: { id: supplierProduct.id },
        data: { lastConfirmedStatus: "IN_STOCK", lastConfirmedAt: new Date() },
      });
      if (supplierProduct.isPrimary && supplierProduct.variantId) {
        await setAvailability({
          variantId: supplierProduct.variantId,
          productId: supplierProduct.productId,
          status: "IN_STOCK",
          source: "SUPPLIER_CONFIRMED",
          changedBy: batch.supplierId,
        });
      }
      await prisma.productImportItem.update({
        where: { id: item.id },
        data: { status: "LINKED_EXISTING", resultMatchedProductId: catalogMatch.product.id, processedAt: new Date() },
      });
      return { kind: "linked" };
    }

    // Not live in the catalog yet — but it might already be SUBMITTED
    // (one-by-one chat flow, or an earlier bulk batch) and just sitting
    // unapproved, which findExistingCatalogMatch above can't see (no
    // Product/Variant row exists for it yet). Confirmed live: the same
    // item got drafted twice, a day apart, once via each flow.
    const pendingMatch = await findPendingDraftMatch({ title: item.title, sku: variants[0]?.sku });
    if (pendingMatch) {
      await prisma.productImportItem.update({
        where: { id: item.id },
        data: { status: "ALREADY_DRAFTED", resultProductDraftId: pendingMatch.draftId, processedAt: new Date() },
      });
      return { kind: "already_drafted" };
    }

    // Genuinely new. Specs research runs once per item regardless (a
    // document that already gave a usable description would skip this,
    // but bulk-imported rows never carry one — just title/sku/mrp). Only
    // asks it to ALSO search for an image when there's exactly one variant
    // and the document didn't already supply a photo for it — for any
    // item with real multiple variants, a shared/guessed image at the
    // product level isn't wanted at all; each variant gets its own
    // resolution below instead (document photo, or its own dedicated
    // researchVariantImage call), never a single image reused across
    // colors/sizes.
    const needsSharedImage = variants.length === 1 && !variants[0].documentImageUrl;
    const research = await researchProductSpecs({ title: item.title, brand: item.brand, needsImage: needsSharedImage });

    if (batch.conversationId) {
      try {
        await prisma.agentUsage.create({
          data: {
            conversationId: batch.conversationId,
            productImportBatchId: batch.id,
            agentName: "SUPPLIER_BULK_IMPORT",
            model: "claude-sonnet-4-6",
            inputTokens: research.usage.inputTokens,
            outputTokens: research.usage.outputTokens,
            costUsd: research.cost.usd,
            costInr: research.cost.inr,
            toolCallCount: 1,
            outcome: research.specs || research.imageUrl ? "researched" : "no_result",
          },
        });
      } catch (err) {
        console.error(`[job] productImportDrain: AgentUsage log failed for item ${item.id}:`, err.message);
      }
    }

    // Resolve each variant's own final image: the document's own photo if
    // it has one (free — already extracted/uploaded), else the shared
    // research result for the single-variant case, else its own dedicated
    // per-variant web search — confirmed/accepted trade-off: a multi-color
    // product with no document photos runs one researchVariantImage call
    // PER missing color, not one shared search reused across all of them.
    for (const v of variants) {
      if (v.documentImageUrl) {
        v.resolvedImageUrl = v.documentImageUrl;
        continue;
      }
      if (variants.length === 1) {
        v.resolvedImageUrl = research.imageUrl || null;
        continue;
      }
      const imgResearch = await researchVariantImage({ title: item.title, brand: item.brand, variantValue: v.value });
      v.resolvedImageUrl = imgResearch.imageUrl || null;
      if (batch.conversationId) {
        try {
          await prisma.agentUsage.create({
            data: {
              conversationId: batch.conversationId,
              productImportBatchId: batch.id,
              agentName: "SUPPLIER_BULK_IMPORT",
              model: "claude-sonnet-4-6",
              inputTokens: imgResearch.usage.inputTokens,
              outputTokens: imgResearch.usage.outputTokens,
              costUsd: imgResearch.cost.usd,
              costInr: imgResearch.cost.inr,
              toolCallCount: 1,
              outcome: imgResearch.imageUrl ? "variant_image_researched" : "no_result",
            },
          });
        } catch (err) {
          console.error(`[job] productImportDrain: AgentUsage log failed for item ${item.id} variant ${v.value}:`, err.message);
        }
      }
    }

    // Initial product-level image for the creation call itself — real
    // per-variant images get attached as a follow-up step below (Shopify
    // variant IDs don't exist until after creation), this is just so the
    // product isn't image-less in the meantime if that follow-up partially
    // fails. Prefers the shared research result, else the first variant
    // that actually resolved one.
    const fallbackImageUrl = research.imageUrl || variants.find((v) => v.resolvedImageUrl)?.resolvedImageUrl || null;

    // product_type/tags drive this store's real collections (mostly smart
    // collections keyed on vendor or tags, confirmed against live data) —
    // broadTagFor looks up the matching UPPERCASE category tag for
    // whatever specific type the extraction call chose (shopifyTaxonomy.js).
    const broadTag = broadTagFor(item.shopifyProductType);
    const tags = [broadTag, item.shopifyProductType, item.brand].filter(Boolean);

    const shopifyResult = await createDraftProduct({
      title: item.title,
      category: item.shopifyProductType || item.category,
      specs: research.specs,
      brand: item.brand || undefined,
      variantOptionName: item.variantOptionName || null,
      variants,
      imageUrl: fallbackImageUrl,
      tags,
    });

    // Attach each variant's own resolved image (document- or web-sourced)
    // now that real Shopify variant IDs exist — variantResults is
    // positionally matched to `variants`, same guarantee the cost-sync
    // loop right below already relies on. Best-effort: a failed attach
    // here doesn't lose the draft, same posture as the cost-sync loop.
    await Promise.all(
      shopifyResult.variantResults.map(async (vr, i) => {
        const resolvedImageUrl = variants[i]?.resolvedImageUrl;
        if (!resolvedImageUrl) return;
        try {
          await addVariantImage(shopifyResult.shopifyProductId, vr.shopifyVariantId, resolvedImageUrl);
        } catch (err) {
          console.error(
            `[job] productImportDrain: addVariantImage failed for variant ${vr.shopifyVariantId} on ${shopifyResult.shopifyProductId}:`,
            err.response?.data || err.message,
          );
        }
      }),
    );

    // One cost-price sync per real Shopify variant — margin/GST are the
    // batch's blanket rate, but each variant can have its own MRP (rare
    // in practice for this catalog shape, but the document sometimes does
    // vary price by size), so cost price is computed per variant, not once
    // for the whole product.
    const variantCostResults = await Promise.all(
      shopifyResult.variantResults.map(async (vr) => {
        const costPrice = computeCostPrice({
          mrp: vr.mrp,
          marginPercent: Number(item.marginPercent),
          gstPercent: Number(item.gstPercent),
        });
        const costResult = await updateInventoryItemCost(vr.shopifyVariantId, costPrice);
        if (!costResult.ok) {
          console.error(
            `[job] productImportDrain: Shopify cost sync failed for variant ${vr.shopifyVariantId} on ${shopifyResult.shopifyProductId}:`,
            costResult.error,
          );
        }
        return { shopifyVariantId: vr.shopifyVariantId, mrp: vr.mrp, costPrice };
      }),
    );

    const approvalToken = crypto.randomBytes(24).toString("hex");
    const tokenExpiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const anyDocumentImage = variants.some((v) => v.documentImageUrl);
    const draft = await prisma.productDraft.create({
      data: {
        shopifyDraftProductId: shopifyResult.shopifyProductId,
        supplierId: batch.supplierId,
        // A real photo pulled from the supplier's own document is more
        // "SUPPLIER_PROVIDED" in spirit than "WEB_SCRAPED", even though it
        // arrived via the bulk-document pipeline rather than a direct
        // WhatsApp photo — takes priority over whether research also ran.
        sourceType: anyDocumentImage || !(research.specs || research.imageUrl) ? "SUPPLIER_PROVIDED" : "WEB_SCRAPED",
        rawPayload: {
          title: item.title,
          brand: item.brand || null,
          variantOptionName: item.variantOptionName || null,
          variants: variantCostResults.map((vr, i) => ({
            value: variants[i]?.value || null,
            sku: variants[i]?.sku || null,
            mrp: vr.mrp,
            costPrice: vr.costPrice,
            imageUrl: variants[i]?.resolvedImageUrl || null,
          })),
          // Mirrors of the first/primary variant, in the exact field
          // names backend's productDraftController.js (the shared
          // approval page, not touched by this change) already reads —
          // so that page keeps rendering sensibly for a multi-variant
          // draft without needing its own rewrite. variantOptions here is
          // display-only, a hint that more variants exist; it doesn't
          // drive creation (variants above already did that).
          price: variants[0]?.mrp,
          sku: variants[0]?.sku || null,
          costPrice: variantCostResults[0]?.costPrice ?? null,
          variantOptions:
            item.variantOptionName && variants[0]?.value
              ? [{
                  name: item.variantOptionName,
                  value: variants.length > 1 ? `${variants[0].value} (+${variants.length - 1} more variant${variants.length > 2 ? "s" : ""})` : variants[0].value,
                }]
              : [],
          marginPercent: Number(item.marginPercent),
          gstPercent: Number(item.gstPercent),
          specs: research.specs,
          imageUrl: fallbackImageUrl,
          sourceNotes: research.sourceNotes || "Bulk catalog import — no per-item supplier Q&A, margin/GST are the batch's blanket rate.",
        },
        approvalToken,
        tokenExpiresAt,
      },
    });

    await prisma.productImportItem.update({
      where: { id: item.id },
      data: { status: "DRAFTED", resultProductDraftId: draft.id, processedAt: new Date() },
    });

    return { kind: "drafted", title: item.title, token: approvalToken };
  } catch (err) {
    console.error(`[job] productImportDrain: item ${item.id} (${item.title}) failed:`, err.message);
    await prisma.productImportItem.update({
      where: { id: item.id },
      data: { status: "FAILED", errorMessage: String(err.message).slice(0, 500), processedAt: new Date() },
    });
    return { kind: "failed" };
  }
}

// Flips a batch to DONE and sends the one digest email once every item
// is accounted for (drafted/linked/failed, OR already pre-counted as
// NEEDS_RATE at extraction time — see extractPendingBatch). Shared by the
// normal per-tick drain loop AND extraction itself, because a batch where
// EVERY item comes back NEEDS_RATE never has anything PENDING for the
// drain loop to ever touch — without this being called from extraction
// too, such a batch would sit at PROCESSING forever with no completion
// email, leaving staff with no signal that it's stuck needing rate info.
async function finalizeBatchIfComplete(batchId) {
  const batch = await prisma.productImportBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.status !== "PROCESSING") return;
  if (batch.processedItems < batch.totalItems) return;

  const updated = await prisma.productImportBatch.update({
    where: { id: batchId },
    data: { status: "DONE", completedAt: new Date() },
  });

  // Re-fetch every drafted item across the WHOLE batch (not just the
  // triggering tick's slice) for the digest — earlier ticks' drafts need
  // to be in the same email too.
  const allDrafted = await prisma.productImportItem.findMany({
    where: { batchId, status: "DRAFTED", resultProductDraftId: { not: null } },
    select: { title: true, resultProductDraftId: true },
  });
  const drafts = await prisma.productDraft.findMany({
    where: { id: { in: allDrafted.map((d) => d.resultProductDraftId) } },
    select: { id: true, approvalToken: true },
  });
  const tokenByDraftId = new Map(drafts.map((d) => [d.id, d.approvalToken]));
  const draftedItems = allDrafted
    .map((d) => ({ title: d.title, token: tokenByDraftId.get(d.resultProductDraftId) }))
    .filter((d) => d.token);

  const needsRateItems = await prisma.productImportItem.findMany({
    where: { batchId, status: "NEEDS_RATE" },
    select: { title: true, brand: true, category: true },
  });

  const supplier = await prisma.supplier.findUnique({ where: { id: updated.supplierId } });
  try {
    await sendBulkImportDigestEmail({
      supplierName: supplier?.name || "Unknown supplier",
      totalItems: updated.totalItems,
      draftedItems,
      linkedCount: updated.linkedCount,
      failedCount: updated.failedCount,
      needsRateItems,
    });
  } catch (err) {
    console.error(`[job] productImportDrain: digest email failed for batch ${batchId}:`, err.message);
  }

  if (supplier) {
    try {
      await sendBulkImportCompletionMessage({
        supplier,
        draftedCount: draftedItems.length,
        linkedCount: updated.linkedCount,
        needsRateCount: needsRateItems.length,
      });
    } catch (err) {
      console.error(`[job] productImportDrain: supplier completion message failed for batch ${batchId}:`, err.message);
    }
  }
}

async function drainProductImportQueue() {
  const pending = await prisma.productImportItem.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });
  if (pending.length === 0) return { processed: 0 };

  const batchIds = [...new Set(pending.map((p) => p.batchId))];
  const batches = await prisma.productImportBatch.findMany({ where: { id: { in: batchIds } } });
  const batchById = new Map(batches.map((b) => [b.id, b]));

  const perBatchTally = new Map(); // batchId -> { drafted: [{title,token}], linked: number, failed: number }
  const tallyFor = (batchId) => {
    if (!perBatchTally.has(batchId)) perBatchTally.set(batchId, { drafted: [], linked: 0, failed: 0 });
    return perBatchTally.get(batchId);
  };

  await mapSequentialPaced(pending, PACE_MS, async (item) => {
    const batch = batchById.get(item.batchId);
    const tally = tallyFor(item.batchId);
    const result = await processItem(item, batch);
    if (result.kind === "drafted") tally.drafted.push({ title: result.title, token: result.token });
    else if (result.kind === "linked") tally.linked += 1;
    // already_drafted isn't a failure — it's counted in processedItems
    // below (processedThisTick counts every item regardless of kind), just
    // not in any of the drafted/linked/failed buckets specifically. No
    // batch-level counter for it yet (informational, not actionable —
    // visible per-item via ImportItemStatus.ALREADY_DRAFTED).
    else if (result.kind === "already_drafted") {
      // no-op
    } else tally.failed += 1;
  });

  for (const [batchId, tally] of perBatchTally) {
    const processedThisTick = pending.filter((p) => p.batchId === batchId).length;
    await prisma.productImportBatch.update({
      where: { id: batchId },
      data: {
        processedItems: { increment: processedThisTick },
        draftedCount: { increment: tally.drafted.length },
        linkedCount: { increment: tally.linked },
        failedCount: { increment: tally.failed },
      },
    });
    await finalizeBatchIfComplete(batchId);
  }

  return { processed: pending.length };
}

let isRunning = false;

function registerProductImportDrainJob() {
  cron.schedule("*/5 * * * *", async () => {
    if (isRunning) {
      console.log("[job] product import drain already running, skipping this tick.");
      return;
    }
    isRunning = true;
    try {
      const extraction = await extractPendingBatch();
      if (extraction) {
        console.log(
          `[job] product import drain — extracted ${extraction.extracted} item(s) for batch ${extraction.batchId}${extraction.failed ? " (failed, will retry)" : ""}.`,
        );
      }
      const { processed } = await drainProductImportQueue();
      if (processed > 0) {
        console.log(`[job] product import drain complete — ${processed} item(s) processed.`);
      }
    } catch (err) {
      console.error("[job] product import drain failed:", err.message);
    } finally {
      isRunning = false;
    }
  });
}

module.exports = { registerProductImportDrainJob, drainProductImportQueue, extractPendingBatch };
