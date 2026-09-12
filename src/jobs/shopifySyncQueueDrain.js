// src/jobs/shopifySyncQueueDrain.js
//
// Catches up Shopify inventory writes a bulk backend operation deferred.
// confirm_all_pending_items (golfcare-backend's supplierAgentTools.js)
// caps how many variants get their Shopify inventory level pushed inline
// per request — each push is 2-3 Admin API calls (see shopifyInventory.js),
// so doing that for hundreds/thousands of items in one webhook request
// risks a serverless timeout and hammers Shopify's rate limit. Golf Care
// OS's own AvailabilityState (the real source of truth) is already
// correct by the time a row lands here — this job's only job is pushing
// the matching Shopify inventory level, gradually and rate-limit-safely,
// from a process (this scheduler) with no request-timeout ceiling.
//
// isRunning guard + small batch + bounded concurrency: same reasoning as
// shopifyReconciliation.js, just tuned for a queue that can be refilled
// faster than it drains (bulk confirms happen in bursts) rather than a
// single long nightly run.

const cron = require("node-cron");
const { prisma } = require("../lib/prisma");
const { writeAvailabilityToShopify } = require("../lib/shopifyInventory");

const BATCH_SIZE = Number(process.env.SHOPIFY_SYNC_QUEUE_BATCH_SIZE || 100);
const CONCURRENCY = Number(process.env.SHOPIFY_SYNC_QUEUE_CONCURRENCY || 3);
const MAX_ATTEMPTS = Number(process.env.SHOPIFY_SYNC_QUEUE_MAX_ATTEMPTS || 5);

async function mapWithConcurrency(items, limit, fn) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function drainShopifySyncQueue() {
  const pending = await prisma.shopifySyncQueue.findMany({
    where: { processedAt: null, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });
  if (pending.length === 0) return { processed: 0, failed: 0 };

  const variants = await prisma.variant.findMany({
    where: { id: { in: pending.map((p) => p.variantId) } },
    select: { id: true, shopifyVariantId: true },
  });
  const shopifyVariantIdByVariantId = new Map(variants.map((v) => [v.id, v.shopifyVariantId]));

  let processed = 0;
  let failed = 0;

  await mapWithConcurrency(pending, CONCURRENCY, async (row) => {
    const shopifyVariantId = shopifyVariantIdByVariantId.get(row.variantId);
    if (!shopifyVariantId) {
      // Variant no longer exists (deleted since queued) — nothing to sync,
      // don't keep retrying it forever.
      await prisma.shopifySyncQueue.update({
        where: { id: row.id },
        data: { processedAt: new Date(), lastError: "variant_not_found" },
      });
      failed += 1;
      return;
    }

    const result = await writeAvailabilityToShopify({ shopifyVariantId }, row.status);
    if (result.ok) {
      await prisma.shopifySyncQueue.update({
        where: { id: row.id },
        data: { processedAt: new Date() },
      });
      processed += 1;
    } else {
      const errorText =
        typeof result.error === "string" ? result.error : JSON.stringify(result.error);
      await prisma.shopifySyncQueue.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 }, lastError: errorText },
      });
      failed += 1;
    }
  });

  return { processed, failed };
}

let isRunning = false;

function registerShopifySyncQueueDrainJob() {
  cron.schedule("*/5 * * * *", async () => {
    if (isRunning) {
      console.log("[job] Shopify sync queue drain already running, skipping this tick.");
      return;
    }
    isRunning = true;
    try {
      const { processed, failed } = await drainShopifySyncQueue();
      if (processed > 0 || failed > 0) {
        console.log(
          `[job] Shopify sync queue drain complete — ${processed} synced, ${failed} failed/retrying.`,
        );
      }
    } catch (err) {
      console.error("[job] Shopify sync queue drain failed:", err.message);
    } finally {
      isRunning = false;
    }
  });
}

module.exports = { registerShopifySyncQueueDrainJob, drainShopifySyncQueue };
