//src/jobs/approvalTokenExpirySweep.js

const cron = require("node-cron");

function registerApprovalTokenExpirySweepJob() {
  cron.schedule("0 * * * *", async () => {
    // TODO (Module 5): expire stale ProductDraft approval tokens
    console.log("[job] approval token expiry sweep — not yet implemented");
  });
}

module.exports = { registerApprovalTokenExpirySweepJob };
