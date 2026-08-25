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

console.log("Golf Care OS scheduler starting...");

registerAvailabilityDecayJob();
registerSupplierCheckDispatchJob();
registerCampaignTriggerEvalJob();
registerTemplateStatusPollJob();
registerTemplateDeletionSweepJob();
registerApprovalTokenExpirySweepJob();

// add near the other register calls:
registerShopifyReconciliationJob();

console.log("Golf Care OS scheduler: all jobs registered.");
