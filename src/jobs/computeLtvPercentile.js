//src/jobs/computeLtvPercentile.js
//
// Nightly. Ranks every member by lifetimeValue and writes
// Customer.ltvPercentile — a 0-100 number where LOWER means a BETTER
// (higher-spending) customer, e.g. 5 means "top 5% by lifetime value."
// This is what the pricing engine's LTV lever (lever.ltv.topPercentile)
// compares against.
//
// Ranked among members only (isMember = true) — non-members never reach
// the pricing engine far enough for this field to matter (see
// computeEnvelope's short-circuit), so there's no reason to rank them.
//
// Uses a single SQL statement (PERCENT_RANK window function) rather
// than looping per-customer in JS — correct and fast even as the
// customer table grows, and it's a pure re-ranking each run so it's
// safe to overwrite every member's value every night.

const cron = require("node-cron");
const { prisma } = require("../lib/prisma");

async function computeLtvPercentile() {
  const result = await prisma.$executeRawUnsafe(`
    WITH ranked AS (
      SELECT id, PERCENT_RANK() OVER (ORDER BY "lifetimeValue" DESC) AS pct
      FROM "Customer"
      WHERE "isMember" = true
    )
    UPDATE "Customer" c
    SET "ltvPercentile" = CEIL(ranked.pct * 100)::int
    FROM ranked
    WHERE c.id = ranked.id;
  `);
  return { updated: result };
}

function registerComputeLtvPercentileJob() {
  // 2:30am daily — after order/customer data from the day has settled,
  // well before working hours.
  cron.schedule("30 2 * * *", async () => {
    console.log("[job] ltv percentile recompute starting...");
    try {
      const { updated } = await computeLtvPercentile();
      console.log(
        `[job] ltv percentile recompute complete — ${updated} member(s) updated.`,
      );
    } catch (err) {
      console.error("[job] ltv percentile recompute failed:", err.message);
    }
  });
}

module.exports = { registerComputeLtvPercentileJob, computeLtvPercentile };
