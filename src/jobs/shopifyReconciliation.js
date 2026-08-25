// src/jobs/shopifyReconciliation.js
//
// Nightly full-catalog re-sync. Complements the real-time webhooks running
// in golfcare-backend (Vercel) — this is the safety net for anything a
// webhook missed (backend downtime, a dropped delivery, or Shopify
// auto-deleting the webhook subscription after ~48h of failed deliveries).
// Same upsert logic as the one-time import, safe to re-run indefinitely.
//
// isRunning guard: a full import can take several minutes. Without this,
// a short cron interval (e.g. testing with "* * * * *") would fire
// overlapping runs before the previous one finishes, multiplying DB load
// for no reason. Harmless at the real "0 3 * * *" schedule, but cheap
// insurance either way.

const cron = require("node-cron");
const { importAllProducts } = require("../lib/shopify");

let isRunning = false;

function registerShopifyReconciliationJob() {
  cron.schedule("* * * * *", async () => {
    if (isRunning) {
      console.log(
        "[job] Shopify reconciliation already running, skipping this tick.",
      );
      return;
    }
    isRunning = true;
    console.log("[job] Shopify reconciliation starting...");
    try {
      const result = await importAllProducts();
      console.log(
        `[job] Shopify reconciliation complete: ${result.totalImported} products across ${result.pages} page(s).`,
      );
    } catch (err) {
      console.error(
        "[job] Shopify reconciliation failed:",
        err.response?.data || err.message,
      );
    } finally {
      isRunning = false;
    }
  });
}

module.exports = { registerShopifyReconciliationJob };
