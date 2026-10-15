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
const { prisma } = require("../lib/prisma");
const { setAvailability } = require("../services/availabilityService");
const { findExistingCatalogMatch } = require("../lib/productCatalogMatch");
const { researchProductSpecs } = require("../lib/claude/researchProductSpecs");
const { extractBulkCatalogItems } = require("../lib/claude/extractBulkCatalogItems");
const { createDraftProduct } = require("../lib/shopify");
const { updateInventoryItemCost } = require("../lib/shopifyInventory");
const { computeCostPrice } = require("../lib/pricingCalculator");
const { sendBulkImportDigestEmail } = require("../lib/email/sendBulkImportDigestEmail");

const BATCH_SIZE = Number(process.env.PRODUCT_IMPORT_BATCH_SIZE || 5);
const PACE_MS = Number(process.env.PRODUCT_IMPORT_PACE_MS || 2000);
const TOKEN_EXPIRY_DAYS = Number(process.env.PRODUCT_DRAFT_TOKEN_EXPIRY_DAYS || 7);
// Sane upper bound on one document's extraction — a guard against a
// garbled/duplicated extraction producing an absurd item count, not a
// real business limit.
const MAX_ITEMS_PER_BATCH = Number(process.env.BULK_PRODUCT_IMPORT_MAX_ITEMS || 1000);

// Parses one PENDING_EXTRACTION batch's raw document text into real
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
    const { items, usage, cost, segmentCount } = await extractBulkCatalogItems({
      documentText: batch.rawDocumentText || "",
    });

    if (batch.conversationId) {
      try {
        await prisma.agentUsage.create({
          data: {
            conversationId: batch.conversationId,
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

    const cleanItems = items.slice(0, MAX_ITEMS_PER_BATCH).map((i) => ({
      batchId: batch.id,
      title: i.title,
      sku: i.sku || null,
      brand: i.brand || null,
      mrp: i.mrp,
      marginPercent: batch.marginPercent,
      gstPercent: batch.gstPercent,
    }));

    if (cleanItems.length === 0) {
      await prisma.productImportBatch.update({
        where: { id: batch.id },
        data: { status: "DONE", completedAt: new Date(), extractionError: "No priced product rows found in document." },
      });
      return { batchId: batch.id, extracted: 0 };
    }

    await prisma.productImportItem.createMany({ data: cleanItems });
    await prisma.productImportBatch.update({
      where: { id: batch.id },
      data: { totalItems: cleanItems.length, status: "PROCESSING" },
    });
    return { batchId: batch.id, extracted: cleanItems.length };
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
    const variantOptions = Array.isArray(item.variantOptions) ? item.variantOptions : [];
    const catalogMatch = await findExistingCatalogMatch({
      title: item.title,
      sku: item.sku,
      variantOptions,
    });

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

    // Genuinely new. Research fills specs/image only if missing — a
    // document that already gave a usable description would skip this,
    // but bulk-imported rows never carry one (just title/sku/mrp), so
    // this always runs here.
    const research = await researchProductSpecs({ title: item.title, brand: item.brand });

    // Real, now-approved spend (boss sign-off on bulk onboarding cost) —
    // logged the same way every other Module 6 Claude call is, so it
    // shows up alongside Sales/Supplier/Lifecycle usage once that part of
    // the dashboard is built. batch.conversationId is the real supplier
    // conversation the document arrived on (set by start_bulk_product_import).
    if (batch.conversationId) {
      try {
        await prisma.agentUsage.create({
          data: {
            conversationId: batch.conversationId,
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

    const shopifyResult = await createDraftProduct({
      title: item.title,
      price: Number(item.mrp),
      specs: research.specs,
      brand: item.brand || undefined,
      sku: item.sku || undefined,
      variantOptions,
      imageUrl: research.imageUrl,
    });

    const costPrice = computeCostPrice({
      mrp: Number(item.mrp),
      marginPercent: Number(item.marginPercent),
      gstPercent: Number(item.gstPercent),
    });
    const costResult = await updateInventoryItemCost(shopifyResult.shopifyVariantId, costPrice);
    if (!costResult.ok) {
      console.error(
        `[job] productImportDrain: Shopify cost sync failed for ${shopifyResult.shopifyProductId}:`,
        costResult.error,
      );
    }

    const approvalToken = crypto.randomBytes(24).toString("hex");
    const tokenExpiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const draft = await prisma.productDraft.create({
      data: {
        shopifyDraftProductId: shopifyResult.shopifyProductId,
        supplierId: batch.supplierId,
        sourceType: research.specs || research.imageUrl ? "WEB_SCRAPED" : "SUPPLIER_PROVIDED",
        rawPayload: {
          title: item.title,
          price: Number(item.mrp),
          brand: item.brand || null,
          sku: item.sku || null,
          variantOptions,
          mrp: Number(item.mrp),
          marginPercent: Number(item.marginPercent),
          gstPercent: Number(item.gstPercent),
          costPrice,
          specs: research.specs,
          imageUrl: research.imageUrl,
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
    else tally.failed += 1;
  });

  for (const [batchId, tally] of perBatchTally) {
    const processedThisTick = pending.filter((p) => p.batchId === batchId).length;
    const updated = await prisma.productImportBatch.update({
      where: { id: batchId },
      data: {
        processedItems: { increment: processedThisTick },
        draftedCount: { increment: tally.drafted.length },
        linkedCount: { increment: tally.linked },
        failedCount: { increment: tally.failed },
      },
    });

    if (updated.status === "PROCESSING" && updated.processedItems >= updated.totalItems) {
      await prisma.productImportBatch.update({
        where: { id: batchId },
        data: { status: "DONE", completedAt: new Date() },
      });

      // Re-fetch every drafted item across the WHOLE batch (not just this
      // tick's slice) for the digest — earlier ticks' drafts need to be
      // in the same email too.
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

      const supplier = await prisma.supplier.findUnique({ where: { id: updated.supplierId } });
      try {
        await sendBulkImportDigestEmail({
          supplierName: supplier?.name || "Unknown supplier",
          totalItems: updated.totalItems,
          draftedItems,
          linkedCount: updated.linkedCount,
          failedCount: updated.failedCount,
        });
      } catch (err) {
        console.error(`[job] productImportDrain: digest email failed for batch ${batchId}:`, err.message);
      }
    }
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
