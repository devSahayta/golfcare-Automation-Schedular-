//src/jobs/supplierCheckDispatch.js

const cron = require("node-cron");

function registerSupplierCheckDispatchJob() {
  cron.schedule("*/15 * * * *", async () => {
    // TODO (Module 5): find suppliers due for a check, send interactive message
    console.log("[job] supplier check dispatch — not yet implemented");
  });
}

module.exports = { registerSupplierCheckDispatchJob };
