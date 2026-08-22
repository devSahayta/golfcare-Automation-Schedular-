const cron = require("node-cron");

function registerAvailabilityDecayJob() {
  cron.schedule("0 * * * *", async () => {
    // TODO (Module 2): flip expired AvailabilityState rows to UNKNOWN, queue re-check
    console.log("[job] availability decay sweep — not yet implemented");
  });
}

module.exports = { registerAvailabilityDecayJob };
