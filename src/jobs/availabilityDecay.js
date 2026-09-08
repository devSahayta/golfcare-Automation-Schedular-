//src/jobs/availabilityDecay.js
//
// Module 2 TTL sweep. Hourly: any AvailabilityState whose expiresAt has
// passed and isn't already UNKNOWN gets flipped to UNKNOWN via
// setAvailability() — the same function every other caller uses, so the
// DB write, AvailabilityLog entry, `availability.changed` event, and
// Shopify write-back all happen the normal way.
//
// AvailSource has no "expired by system" value in the schema (only
// SUPPLIER_CONFIRMED / MANUAL_OWNER / AGENT_INFERRED), so this uses
// AGENT_INFERRED — the status is no longer supplier/staff-confirmed, it's
// the system inferring that the prior confirmation has gone stale.
//
// Module 5's on-demand digest (supplierCheckDispatch.js) reads
// AvailabilityState.status === "UNKNOWN" directly rather than consuming a
// per-expiry event queue, so flipping the status here is itself the
// signal — no separate event needs emitting for that job to pick it up.

const cron = require("node-cron");
const { prisma } = require("../lib/prisma");
const { setAvailability } = require("../services/availabilityService");

const BATCH_SIZE = 100;

async function sweepExpiredAvailability() {
  const expired = await prisma.availabilityState.findMany({
    where: { expiresAt: { lt: new Date() }, status: { not: "UNKNOWN" } },
    select: { variantId: true, productId: true, status: true },
    take: BATCH_SIZE,
  });

  let flipped = 0;
  for (const state of expired) {
    if (!state.variantId) continue; // variantId is nullable in the schema; nothing to key setAvailability's upsert on
    try {
      await setAvailability({
        variantId: state.variantId,
        productId: state.productId,
        status: "UNKNOWN",
        source: "AGENT_INFERRED",
        changedBy: "system:ttl-sweep",
        note: "Confirmation expired (TTL sweep)",
      });

      flipped += 1;
    } catch (err) {
      console.error(
        `[job] availability decay: failed to expire variant ${state.variantId}:`,
        err.message,
      );
    }
  }

  return { flipped, checked: expired.length };
}

function registerAvailabilityDecayJob() {
  cron.schedule("0 * * * *", async () => {
    console.log("[job] availability decay sweep starting...");
    try {
      const { flipped, checked } = await sweepExpiredAvailability();
      console.log(
        `[job] availability decay sweep complete — ${flipped}/${checked} expired variant(s) flipped to UNKNOWN.`,
      );
    } catch (err) {
      console.error("[job] availability decay sweep failed:", err.message);
    }
  });
}

module.exports = { registerAvailabilityDecayJob, sweepExpiredAvailability };
