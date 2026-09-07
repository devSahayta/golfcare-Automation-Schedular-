//src/jobs/approvalTokenExpirySweep.js
//
// Module 5.2 — a ProductDraft's approval link is only good for
// PRODUCT_DRAFT_TOKEN_EXPIRY_DAYS (default 7). Anything still PENDING
// past that flips to EXPIRED, same "hourly sweep" pattern as
// availabilityDecay.js. The Shopify product itself is left as an
// unpublished draft either way — this only marks our own record; nobody
// needs to touch Shopify for an expiry.

const cron = require("node-cron");
const { prisma } = require("../lib/prisma");

async function sweepExpiredApprovalTokens() {
  const result = await prisma.productDraft.updateMany({
    where: { approvalStatus: "PENDING", tokenExpiresAt: { lt: new Date() } },
    data: { approvalStatus: "EXPIRED" },
  });
  return { expired: result.count };
}

function registerApprovalTokenExpirySweepJob() {
  cron.schedule("0 * * * *", async () => {
    console.log("[job] approval token expiry sweep starting...");
    try {
      const { expired } = await sweepExpiredApprovalTokens();
      console.log(`[job] approval token expiry sweep complete — ${expired} draft(s) expired.`);
    } catch (err) {
      console.error("[job] approval token expiry sweep failed:", err.message);
    }
  });
}

module.exports = { registerApprovalTokenExpirySweepJob, sweepExpiredApprovalTokens };
