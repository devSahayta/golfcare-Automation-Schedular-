//src/index.js

require("dotenv").config();
const { registerAvailabilityDecayJob } = require("./jobs/availabilityDecay");
const {
  registerSupplierCheckDispatchJob,
} = require("./jobs/supplierCheckDispatch");
const {
  registerCampaignTriggerEvalJob,
} = require("./jobs/campaignTriggerEval");
const { registerTemplateStatusPollJob } = require("./jobs/templateStatusPoll");
const {
  registerTemplateDeletionSweepJob,
} = require("./jobs/templateDeletionSweep");
const {
  registerApprovalTokenExpirySweepJob,
} = require("./jobs/approvalTokenExpirySweep");

const {
  registerShopifyReconciliationJob,
} = require("./jobs/shopifyReconciliation");
const {
  registerShopifySyncQueueDrainJob,
} = require("./jobs/shopifySyncQueueDrain");
const { registerProductImportDrainJob } = require("./jobs/productImportDrain");

const {
  registerCampaignImageCleanupJob,
} = require("./jobs/campaignImageCleanup");

const {
  registerProductImportImageCleanupJob,
} = require("./jobs/productImportImageCleanup");

console.log("Golf Care OS scheduler starting...");

registerAvailabilityDecayJob();
registerSupplierCheckDispatchJob();
registerCampaignTriggerEvalJob();
registerTemplateStatusPollJob();
registerTemplateDeletionSweepJob();
registerApprovalTokenExpirySweepJob();

// add near the other register calls:
registerShopifyReconciliationJob();
registerShopifySyncQueueDrainJob();
registerProductImportDrainJob();
registerCampaignImageCleanupJob();
registerProductImportImageCleanupJob();

console.log("Golf Care OS scheduler: all jobs registered.");
