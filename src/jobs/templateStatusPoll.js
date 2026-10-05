//src/jobs/templateStatusPoll.js
//
// Module 6 — two concerns, one tick (same isRunning-guard pattern as
// supplierCheckDispatch.js):
//   1. Poll Meta approval status for anything already submitted
//      (metaStatus: SUBMITTED). No webhook exists for this on Samvaadik's
//      public API — confirmed from the real route file, only
//      GET /v1/templates/:wt_id exists — so polling is the only option,
//      not a design choice. On reaching META_APPROVED, immediately
//      schedules the actual send.
//   2. Poll delivery status for anything already scheduled (non-null
//      samvaadikSmId, sendStatus still PENDING) — DynamicTemplate.sendStatus
//      has no SCHEDULED state (only PENDING/SENT/FAILED), so
//      samvaadikSmId being non-null IS the "scheduled" signal; this step
//      is what moves it to the real terminal state.

const cron = require("node-cron");
const { prisma } = require("../lib/prisma");
const {
  getTemplateStatus,
  scheduleTemplateMessage,
  getScheduledMessageStatus,
} = require("../lib/samvaadik/adapter");
const { resolveCustomerConversation } = require("../lib/resolveCustomerConversation");

// Fills {{1}}, {{2}}... in bodyDraft with the real values from variables —
// same substitution logic already used in dynamicTemplateController.js's
// confirm page and sendDynamicTemplateApprovalEmail.js, duplicated here
// (not imported cross-repo — see cross-repo duplication convention) so
// the real Message row logged below carries the actual sent text, not a
// placeholder.
function fillTemplateBody(bodyDraft, variables) {
  let text = bodyDraft || "";
  (Array.isArray(variables) ? variables : []).forEach((v, i) => {
    text = text.replace(`{{${i + 1}}}`, String(v));
  });
  return text;
}

const TIMEZONE = process.env.SCHEDULER_TIMEZONE || "Asia/Kolkata";
const QUIET_HOURS_START = Number(process.env.CAMPAIGN_QUIET_HOURS_START ?? 21);
const QUIET_HOURS_END = Number(process.env.CAMPAIGN_QUIET_HOURS_END ?? 8);
const DELETE_BUFFER_HOURS = Number(process.env.SAMVAADIK_TEMPLATE_DELETE_BUFFER_HOURS || 48);

function getLocalHour(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const hourRaw = parts.find((p) => p.type === "hour").value;
  return hourRaw === "24" ? 0 : Number(hourRaw);
}

// If now falls inside quiet hours (default 21:00–08:00 local), push the
// send to QUIET_HOURS_END today/tomorrow; otherwise send shortly (a small
// buffer so Samvaadik's schedule insert always lands in the future, which
// it validates server-side).
function computeSendTime() {
  const hour = getLocalHour(TIMEZONE);
  const inQuietHours = hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;

  if (!inQuietHours) {
    return new Date(Date.now() + 2 * 60 * 1000);
  }

  const target = new Date();
  target.setMinutes(0, 0, 0);
  if (hour >= QUIET_HOURS_START) {
    // Later than quiet-hours start today — target QUIET_HOURS_END tomorrow.
    target.setDate(target.getDate() + 1);
  }
  target.setHours(QUIET_HOURS_END, 0, 0, 0);
  return target;
}

function batchIdFor(scenario) {
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date()); // YYYY-MM-DD
  return `${scenario}_${dateStr}`;
}

async function pollMetaApprovals() {
  const pending = await prisma.dynamicTemplate.findMany({
    where: { metaStatus: "SUBMITTED", samvaadikWtId: { not: null } },
    include: { Customer: true },
  });

  let scheduled = 0;
  for (const template of pending) {
    let status;
    try {
      status = await getTemplateStatus(template.samvaadikWtId);
    } catch (err) {
      console.error(`[job] templateStatusPoll: status check failed for ${template.id}:`, err.message);
      continue;
    }

    if (status.status === "APPROVED") {
      await prisma.dynamicTemplate.update({
        where: { id: template.id },
        data: { metaStatus: "META_APPROVED", metaApprovedAt: new Date() },
      });

      const templateVariables = {};
      (Array.isArray(template.variables) ? template.variables : []).forEach((v, i) => {
        templateVariables[String(i + 1)] = String(v);
      });

      try {
        const result = await scheduleTemplateMessage({
          phone: template.Customer.waPhone,
          contactName: `${template.Customer.firstName || ""} ${template.Customer.lastName || ""}`.trim() || undefined,
          wtId: template.samvaadikWtId,
          templateVariables,
          scheduledAt: computeSendTime().toISOString(),
          timezone: TIMEZONE,
          batchId: batchIdFor(template.scenario),
        });
        await prisma.dynamicTemplate.update({
          where: { id: template.id },
          data: { samvaadikSmId: result.sm_id, batchId: batchIdFor(template.scenario) },
        });
        scheduled += 1;
      } catch (err) {
        console.error(`[job] templateStatusPoll: scheduling failed for ${template.id}:`, err.message);
      }
    } else if (status.status === "REJECTED") {
      await prisma.dynamicTemplate.update({
        where: { id: template.id },
        data: { metaStatus: "META_REJECTED", metaRejectionReason: "Rejected by Meta" },
      });
      if (template.campaignTriggerId) {
        await prisma.campaignTrigger.update({
          where: { id: template.campaignTriggerId },
          data: { status: "SUPPRESSED", suppressedReason: "meta_rejected" },
        });
      }
    }
    // Anything still PENDING on Meta's side is left alone — next tick checks again.
  }

  return scheduled;
}

async function pollSendStatus() {
  const scheduledRows = await prisma.dynamicTemplate.findMany({
    where: { samvaadikSmId: { not: null }, sendStatus: "PENDING" },
    include: { Customer: true },
  });

  let sent = 0;
  for (const template of scheduledRows) {
    let status;
    try {
      status = await getScheduledMessageStatus(template.samvaadikSmId);
    } catch (err) {
      console.error(`[job] templateStatusPoll: send-status check failed for ${template.id}:`, err.message);
      continue;
    }

    if (status.status === "sent") {
      const sentAt = status.sent_at ? new Date(status.sent_at) : new Date();
      await prisma.dynamicTemplate.update({
        where: { id: template.id },
        data: {
          sendStatus: "SENT",
          sentAt,
          deleteAfter: new Date(sentAt.getTime() + DELETE_BUFFER_HOURS * 60 * 60 * 1000),
        },
      });
      if (template.campaignTriggerId) {
        await prisma.campaignTrigger.update({
          where: { id: template.campaignTriggerId },
          data: { status: "SENT" },
        });
      }

      // Real bug, caught live: this confirmed-sent transition never
      // logged anything into Message/Conversation, unlike the static
      // lane (campaignTriggerEval.js's logSendAndCloseTrigger) — meaning
      // Sales Agent had zero visibility into a cross-sell (or any
      // dynamic-lane) send when the customer later replied. body is the
      // real filled-in text, not null, so it's also visible in raw
      // conversation history, not just via the intent tag below.
      try {
        const conversation = await resolveCustomerConversation(template.Customer);
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            direction: "OUTBOUND",
            sender: "SYSTEM",
            type: "template",
            templateName: template.templateName,
            body: fillTemplateBody(template.bodyDraft, template.variables),
            createdAt: sentAt,
          },
        });
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: sentAt, intent: `campaign_reply:${template.scenario}` },
        });
      } catch (err) {
        console.error(`[job] templateStatusPoll: Message/Conversation log failed for ${template.id}:`, err.message);
      }

      sent += 1;
    } else if (status.status === "failed") {
      await prisma.dynamicTemplate.update({ where: { id: template.id }, data: { sendStatus: "FAILED" } });
      if (template.campaignTriggerId) {
        await prisma.campaignTrigger.update({
          where: { id: template.campaignTriggerId },
          data: { status: "SUPPRESSED", suppressedReason: `send_failed: ${status.error_message || "unknown"}`.slice(0, 250) },
        });
      }
    }
  }

  return sent;
}

let isRunning = false;

function registerTemplateStatusPollJob() {
  cron.schedule("*/5 * * * *", async () => {
    if (isRunning) {
      console.log("[job] template status poll already running, skipping this tick.");
      return;
    }
    isRunning = true;
    try {
      const scheduled = await pollMetaApprovals();
      const sent = await pollSendStatus();
      console.log(`[job] template status poll complete — scheduled:${scheduled} sent:${sent}.`);
    } catch (err) {
      console.error("[job] template status poll failed:", err.message);
    } finally {
      isRunning = false;
    }
  });
}

module.exports = { registerTemplateStatusPollJob, pollMetaApprovals, pollSendStatus };
