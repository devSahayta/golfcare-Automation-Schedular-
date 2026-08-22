const cron = require("node-cron");

function registerTemplateDeletionSweepJob() {
  cron.schedule("*/15 * * * *", async () => {
    // TODO (Module 6): delete templates past their deleteAfter window
    console.log("[job] template deletion sweep — not yet implemented");
  });
}

module.exports = { registerTemplateDeletionSweepJob };
