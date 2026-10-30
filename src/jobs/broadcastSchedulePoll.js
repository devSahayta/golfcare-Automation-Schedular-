// src/jobs/broadcastSchedulePoll.js
//
// Closes the loop the Insights agent's schedule_campaign_broadcast tool
// opens (see golfcare-backend/src/services/insightsAgent/insightsAgentTools.js):
// that tool submits a BroadcastCampaign's template to Meta and stores a
// staff-requested scheduledFor, but deliberately does NOT wait for Meta's
// decision (approval can take minutes to hours — far longer than any HTTP
// request should hold open, and this backend runs on Vercel where that's
// a hard timeout, not just a bad idea). Something has to come back later
// and actually fire the send once Meta decides. That's this job.
//
// Same two-concerns-in-one-tick shape as templateStatusPoll.js (which does
// the equivalent thing for DynamicTemplate):
//   1. pollBroadcastApprovals — any BroadcastCampaign sitting at
//      SUBMITTED or PENDING_SCHEDULE with a samvaadikWtId gets its Meta
//      status checked.
//        - SUBMITTED (no agent-requested time — staff will pick a time
//          from the dashboard themselves) → just advance to READY/REJECTED,
//          same transition getCampaign's lazy poll already does on a GET.
//          This is a supplement to that lazy poll, not a replacement: a
//          campaign nobody's dashboard happens to be open for still needs
//          to move off SUBMITTED, which is exactly the gap that let a
//          voice-only agent flow stall before this job existed.
//        - PENDING_SCHEDULE (agent set a requested time) → on approval,
//          re-check consent and fan out to Samvaadik with the *stored*
//          scheduledFor (falling back to "as soon as possible, respecting
//          quiet hours" if that time has already slipped into the past
//          while waiting on Meta — approval delay is out of our control).
//   2. pollBroadcastSendStatus — anything already fanned out
//      (BroadcastRecipient rows with a samvaadikSmId, not yet in a
//      terminal status) gets its delivery status checked and the
//      campaign's aggregate counts/COMPLETED state updated. Same gap as
//      above: getCampaign's live refresh only runs while a human has the
//      card open, and a campaign scheduled purely by voice may never have
//      that happen.
//
// Fan-out logic here is a deliberate duplicate of
// golfcare-backend/src/services/broadcastFanOutService.js, not an import —
// this is a separate repo/process/deploy, so the two can't share code
// directly. Same "cross-repo duplication" convention already used
// elsewhere in this scheduler (see fillTemplateBody in
// templateStatusPoll.js). Keep the two in sync if the fan-out shape ever
// changes.

const cron = require("node-cron");
const { prisma } = require("../lib/prisma");
const {
  getTemplateStatus,
  scheduleTemplateMessage,
  getScheduledMessageStatus,
} = require("../lib/samvaadik/adapter");

const TIMEZONE = process.env.SCHEDULER_TIMEZONE || "Asia/Kolkata";
const QUIET_HOURS_START = Number(process.env.CAMPAIGN_QUIET_HOURS_START ?? 21);
const QUIET_HOURS_END = Number(process.env.CAMPAIGN_QUIET_HOURS_END ?? 8);
const BATCH_SIZE = 10;
const SEND_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getLocalHour(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const raw = parts.find((p) => p.type === "hour").value;
  return raw === "24" ? 0 : Number(raw);
}

// ASAP, respecting quiet hours — used only when a staff-requested
// scheduledFor has already passed by the time Meta approves.
function computeAsapSendTime() {
  const hour = getLocalHour(TIMEZONE);
  const inQuietHours = hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
  if (!inQuietHours) return new Date(Date.now() + 2 * 60 * 1000);
  const target = new Date();
  target.setMinutes(0, 0, 0);
  if (hour >= QUIET_HOURS_START) target.setDate(target.getDate() + 1);
  target.setHours(QUIET_HOURS_END, 0, 0, 0);
  return target;
}

// Clamp an explicit requested time that still IS in the future, but falls
// inside quiet hours, to the next quiet-hours-end — same rule the
// dashboard's manual "Schedule for later" already applies.
function clampQuietHours(sendAt) {
  const chosenHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      hour: "numeric",
      hour12: false,
    })
      .formatToParts(sendAt)
      .find((p) => p.type === "hour").value,
  );
  if (chosenHour < QUIET_HOURS_START && chosenHour >= QUIET_HOURS_END) {
    return { effectiveSendAt: sendAt, adjusted: false };
  }
  const effectiveSendAt = new Date(sendAt);
  if (chosenHour >= QUIET_HOURS_START)
    effectiveSendAt.setDate(effectiveSendAt.getDate() + 1);
  effectiveSendAt.setHours(QUIET_HOURS_END, 0, 0, 0);
  return { effectiveSendAt, adjusted: true };
}

function writeAudit(action, campaignId, before, after) {
  return prisma.auditLog.create({
    data: {
      actorType: "AGENT",
      action,
      entityType: "BroadcastCampaign",
      entityId: campaignId,
      beforeState: before || null,
      afterState: after || null,
      source: "broadcast_schedule_poll",
    },
  });
}

// Re-checks consent, skips anyone who's opted out since the draft/preview
// was built, marks the campaign SCHEDULED, and fans out to Samvaadik.
// Mirrors broadcastFanOutService.js's prepareFanOut + fanOutBroadcastCampaign
// (see that file's comments for why this shape exists), minus the HTTP
// response concerns — this runs in a long-lived cron tick, not a Vercel
// function, so there's no freeze risk and no need to split "respond" from
// "do the work" the way the backend's endpoints must.
async function fanOutApprovedCampaign(campaign, requestedSendAt) {
  let sendAt = requestedSendAt;
  if (sendAt <= new Date()) {
    // Approval took long enough that the staff-requested time has already
    // passed. Policy: send ASAP (respecting quiet hours) rather than stall
    // forever waiting for a time that will never come again, and flag it
    // in the audit log so this is visible after the fact.
    sendAt = computeAsapSendTime();
    console.log(
      `[job] broadcastSchedulePoll: requested time for campaign ${campaign.id} had already passed — sending ASAP at ${sendAt.toISOString()} instead.`,
    );
  } else {
    const { effectiveSendAt, adjusted } = clampQuietHours(sendAt);
    if (adjusted) {
      console.log(
        `[job] broadcastSchedulePoll: requested time ${sendAt.toISOString()} for campaign ${campaign.id} falls in quiet hours — moved to ${effectiveSendAt.toISOString()}.`,
      );
    }
    sendAt = effectiveSendAt;
  }

  // Atomic claim — prevents a double-send if this campaign is ever polled
  // by two overlapping schedulers at once (two processes pointed at the
  // same DB, e.g. a local scheduler left running alongside the Render
  // deployment, or two Render instances). The isRunning flag below only
  // guards against overlap within a single process; this guards against
  // overlap across processes. Postgres serializes the two concurrent
  // UPDATEs — whichever commits first flips the status, so the second
  // one's WHERE clause no longer matches and `count` comes back 0.
  const claim = await prisma.broadcastCampaign.updateMany({
    where: { id: campaign.id, status: campaign.status },
    data: { status: "SCHEDULED", scheduledFor: sendAt },
  });
  if (claim.count === 0) {
    console.log(
      `[job] broadcastSchedulePoll: campaign ${campaign.id} already claimed by another poll tick — skipping duplicate fan-out.`,
    );
    return;
  }

  const recipients = await prisma.broadcastRecipient.findMany({
    where: { campaignId: campaign.id, status: "PENDING" },
    select: { id: true, phone: true, firstName: true, customerId: true },
  });

  const customerIds = recipients.map((r) => r.customerId);
  const freshCustomers = await prisma.customer.findMany({
    where: { id: { in: customerIds } },
    select: { id: true, consentMarketing: true, optedOutAt: true },
  });
  const consentMap = new Map(freshCustomers.map((c) => [c.id, c]));

  const eligible = [];
  const skipped = [];
  for (const r of recipients) {
    const c = consentMap.get(r.customerId);
    if (!c) skipped.push({ id: r.id, reason: "customer_not_found" });
    else if (c.optedOutAt) skipped.push({ id: r.id, reason: "opted_out" });
    else if (!c.consentMarketing)
      skipped.push({ id: r.id, reason: "no_consent" });
    else eligible.push(r);
  }

  if (skipped.length > 0) {
    await prisma.$transaction(
      skipped.map((s) =>
        prisma.broadcastRecipient.update({
          where: { id: s.id },
          data: { status: "SKIPPED", skipReason: s.reason },
        }),
      ),
    );
  }

  if (eligible.length === 0) {
    await prisma.broadcastCampaign.update({
      where: { id: campaign.id },
      data: { status: "CANCELLED", skippedCount: skipped.length },
    });
    await writeAudit(
      "AGENT_SCHEDULE_CANCELLED_NO_ELIGIBLE",
      campaign.id,
      { status: campaign.status },
      { status: "CANCELLED", skipped: skipped.length },
    );
    return;
  }

  await prisma.broadcastCampaign.update({
    where: { id: campaign.id },
    data: { skippedCount: skipped.length },
  });
  await writeAudit(
    "AGENT_SCHEDULE_FAN_OUT_STARTED",
    campaign.id,
    { status: campaign.status },
    {
      status: "SCHEDULED",
      scheduledFor: sendAt.toISOString(),
      recipients: eligible.length,
      skipped: skipped.length,
    },
  );

  let scheduledOk = 0;
  let scheduledFail = 0;
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (r) => {
        try {
          const result = await scheduleTemplateMessage({
            phone: r.phone,
            contactName: r.firstName || undefined,
            wtId: campaign.samvaadikWtId,
            templateVariables: { 1: r.firstName || "there" },
            scheduledAt: sendAt.toISOString(),
            timezone: TIMEZONE,
            batchId: campaign.id,
          });
          await prisma.broadcastRecipient.update({
            where: { id: r.id },
            data: { status: "SCHEDULED", samvaadikSmId: result.sm_id },
          });
          scheduledOk++;
        } catch (err) {
          console.error(
            `[job] broadcastSchedulePoll: schedule failed for recipient ${r.id}:`,
            err.message,
          );
          await prisma.broadcastRecipient.update({
            where: { id: r.id },
            data: {
              status: "FAILED",
              errorMessage: err.message?.slice(0, 500),
            },
          });
          scheduledFail++;
        }
      }),
    );
    if (i + BATCH_SIZE < eligible.length) await sleep(SEND_DELAY_MS);
  }

  await prisma.broadcastCampaign.update({
    where: { id: campaign.id },
    data: {
      failedCount: scheduledFail,
      ...(scheduledOk === 0 && scheduledFail > 0 && { status: "FAILED" }),
    },
  });

  console.log(
    `[job] broadcastSchedulePoll: campaign ${campaign.id} fan-out done — ok:${scheduledOk} fail:${scheduledFail} sendAt:${sendAt.toISOString()}`,
  );
}

async function pollBroadcastApprovals() {
  const pending = await prisma.broadcastCampaign.findMany({
    where: {
      status: { in: ["SUBMITTED", "PENDING_SCHEDULE"] },
      samvaadikWtId: { not: null },
    },
  });

  let advanced = 0;
  for (const campaign of pending) {
    let status;
    try {
      status = await getTemplateStatus(campaign.samvaadikWtId);
    } catch (err) {
      console.error(
        `[job] broadcastSchedulePoll: status check failed for ${campaign.id}:`,
        err.message,
      );
      continue;
    }

    if (status.status === "APPROVED") {
      await prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: { metaStatus: "META_APPROVED", metaApprovedAt: new Date() },
      });

      if (campaign.status === "PENDING_SCHEDULE" && campaign.scheduledFor) {
        try {
          await fanOutApprovedCampaign(
            campaign,
            new Date(campaign.scheduledFor),
          );
          advanced += 1;
        } catch (err) {
          console.error(
            `[job] broadcastSchedulePoll: fan-out failed for ${campaign.id}:`,
            err.message,
          );
        }
      } else {
        // Plain SUBMITTED, no agent-requested time — staff still picks
        // "Send now" / "Schedule for later" from the dashboard themselves.
        // Same atomic-claim reasoning as fanOutApprovedCampaign above —
        // otherwise two overlapping schedulers both flip this to READY
        // and both write an audit row.
        const readyClaim = await prisma.broadcastCampaign.updateMany({
          where: { id: campaign.id, status: "SUBMITTED" },
          data: { status: "READY" },
        });
        if (readyClaim.count > 0) {
          await writeAudit(
            "META_APPROVED",
            campaign.id,
            { status: "SUBMITTED" },
            { status: "READY" },
          );
          advanced += 1;
        }
      }
    } else if (status.status === "REJECTED") {
      await prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: {
          status: "REJECTED",
          metaStatus: "META_REJECTED",
          metaRejectionReason: "Rejected by Meta",
        },
      });
      await writeAudit(
        "META_REJECTED",
        campaign.id,
        { status: campaign.status },
        { status: "REJECTED" },
      );
    }
    // Still PENDING on Meta's side — leave alone, next tick checks again.
  }

  return advanced;
}

async function pollBroadcastSendStatus() {
  const campaigns = await prisma.broadcastCampaign.findMany({
    where: { status: "SCHEDULED" },
    include: {
      BroadcastRecipient: {
        where: { samvaadikSmId: { not: null }, status: "SCHEDULED" },
        select: { id: true, samvaadikSmId: true },
      },
    },
  });

  let completed = 0;
  for (const campaign of campaigns) {
    let sentDelta = 0;
    let failedDelta = 0;

    for (const r of campaign.BroadcastRecipient) {
      let status;
      try {
        status = await getScheduledMessageStatus(r.samvaadikSmId);
      } catch (err) {
        console.error(
          `[job] broadcastSchedulePoll: send-status check failed for recipient ${r.id}:`,
          err.message,
        );
        continue;
      }
      if (status.status === "sent") {
        await prisma.broadcastRecipient.update({
          where: { id: r.id },
          data: {
            status: "SENT",
            sentAt: status.sent_at ? new Date(status.sent_at) : new Date(),
          },
        });
        sentDelta += 1;
      } else if (status.status === "failed") {
        await prisma.broadcastRecipient.update({
          where: { id: r.id },
          data: {
            status: "FAILED",
            errorMessage: status.error_message?.slice(0, 500) || null,
          },
        });
        failedDelta += 1;
      }
      // still pending delivery — leave alone
    }

    if (sentDelta > 0 || failedDelta > 0) {
      const remaining = await prisma.broadcastRecipient.count({
        where: { campaignId: campaign.id, status: "SCHEDULED" },
      });
      const [sentCount, failedCount] = await Promise.all([
        prisma.broadcastRecipient.count({
          where: { campaignId: campaign.id, status: "SENT" },
        }),
        prisma.broadcastRecipient.count({
          where: { campaignId: campaign.id, status: "FAILED" },
        }),
      ]);

      await prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: {
          sentCount,
          failedCount,
          ...(remaining === 0 && {
            status: "COMPLETED",
            completedAt: new Date(),
          }),
        },
      });
      if (remaining === 0) completed += 1;
    }
  }

  return completed;
}

let isRunning = false;

function registerBroadcastSchedulePollJob() {
  cron.schedule("*/1 * * * *", async () => {
    if (isRunning) {
      console.log(
        "[job] broadcast schedule poll already running, skipping this tick.",
      );
      return;
    }
    isRunning = true;
    try {
      const advanced = await pollBroadcastApprovals();
      const completed = await pollBroadcastSendStatus();
      console.log(
        `[job] broadcast schedule poll complete — advanced:${advanced} completed:${completed}.`,
      );
    } catch (err) {
      console.error("[job] broadcast schedule poll failed:", err.message);
    } finally {
      isRunning = false;
    }
  });
}

module.exports = {
  registerBroadcastSchedulePollJob,
  pollBroadcastApprovals,
  pollBroadcastSendStatus,
};
