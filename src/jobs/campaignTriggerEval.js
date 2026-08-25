//src/jobs/campaignTriggerEval.js

const cron = require("node-cron");

function registerCampaignTriggerEvalJob() {
  cron.schedule("*/30 * * * *", async () => {
    // TODO (Module 6): evaluate birthday/replenishment/winback/review/cross-sell triggers
    console.log("[job] campaign trigger evaluation — not yet implemented");
  });
}

module.exports = { registerCampaignTriggerEvalJob };
