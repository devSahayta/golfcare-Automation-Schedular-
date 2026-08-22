const cron = require("node-cron");

function registerTemplateStatusPollJob() {
  cron.schedule("*/5 * * * *", async () => {
    // TODO (Module 6): poll Meta template approval status via Samvaadik
    console.log("[job] Meta template status poll — not yet implemented");
  });
}

module.exports = { registerTemplateStatusPollJob };
