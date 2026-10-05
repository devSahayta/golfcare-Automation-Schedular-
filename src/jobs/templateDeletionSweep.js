//src/jobs/templateDeletionSweep.js
//
// Module 6 — deletes one-off dynamic templates once they're genuinely
// done being used. Gated on sendStatus === "SENT" (never anything still
// PENDING-with-a-samvaadikSmId, i.e. scheduled-but-not-yet-confirmed-sent)
// so this can never race Samvaadik's own 409 TEMPLATE_IN_USE guard
// (confirmed from the real deleteTemplate controller: it refuses while any
// scheduled_messages row referencing the template is still "scheduled").
// A single-use template that's already been sent has no reason to be
// reused — deleting it keeps the WABA's template list from accumulating
// one row per personalized send forever.

const cron = require("node-cron");
const { prisma } = require("../lib/prisma");
const { deleteTemplate } = require("../lib/samvaadik/adapter");

async function sweepDueTemplates() {
  const due = await prisma.dynamicTemplate.findMany({
    where: {
      sendStatus: "SENT",
      deleteStatus: "NOT_DUE",
      deleteAfter: { lte: new Date() },
      samvaadikWtId: { not: null },
    },
  });

  let deleted = 0;
  let failed = 0;
  for (const template of due) {
    try {
      await deleteTemplate(template.samvaadikWtId);
      await prisma.dynamicTemplate.update({
        where: { id: template.id },
        data: { deleteStatus: "DELETED", deletedAt: new Date() },
      });
      deleted += 1;
    } catch (err) {
      console.error(`[job] templateDeletionSweep: delete failed for ${template.id}:`, err.message);
      await prisma.dynamicTemplate.update({
        where: { id: template.id },
        data: { deleteStatus: "DELETE_FAILED" },
      });
      failed += 1;
    }
  }

  return { deleted, failed };
}

// A row left in DELETE_FAILED needs a way back into the sweep's own query
// (which only looks at NOT_DUE) — otherwise one transient failure (a
// timeout, a momentary Samvaadik error) would permanently strand it.
// Re-queues anything that's been sitting in DELETE_FAILED for a while,
// same "retry, don't get stuck" principle as every other job in this repo.
async function requeueFailedDeletes() {
  const retryAfterMs = 60 * 60 * 1000; // don't hammer a persistently-failing row every 15 min
  const result = await prisma.dynamicTemplate.updateMany({
    where: {
      deleteStatus: "DELETE_FAILED",
      deleteAfter: { lte: new Date(Date.now() - retryAfterMs) },
    },
    data: { deleteStatus: "NOT_DUE" },
  });
  return result.count;
}

let isRunning = false;

function registerTemplateDeletionSweepJob() {
  cron.schedule("*/15 * * * *", async () => {
    if (isRunning) {
      console.log("[job] template deletion sweep already running, skipping this tick.");
      return;
    }
    isRunning = true;
    try {
      const requeued = await requeueFailedDeletes();
      const { deleted, failed } = await sweepDueTemplates();
      console.log(
        `[job] template deletion sweep complete — deleted:${deleted} failed:${failed} requeued:${requeued}.`,
      );
    } catch (err) {
      console.error("[job] template deletion sweep failed:", err.message);
    } finally {
      isRunning = false;
    }
  });
}

module.exports = { registerTemplateDeletionSweepJob, sweepDueTemplates, requeueFailedDeletes };
