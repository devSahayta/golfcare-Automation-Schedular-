//src/jobs/supplierCheckDispatch.js
//
// Module 5.1 — supplier stock check-in lifecycle. Three concerns, one
// tick, one isRunning guard (same pattern as shopifyReconciliation.js):
//   1. Cadence dispatch — suppliers due per their DAILY/WEEKLY schedule.
//      Covers EVERY product the supplier owns in one message.
//   2. On-demand digest — a once-daily, WEEKLY-suppliers-only safety net
//      for variants that went stale (module 2's TTL sweep) before their
//      next weekly cadence check would naturally re-ask about them. Batched
//      into ONE message listing everything currently stale, not one
//      message per item — an earlier version fired immediately per TTL
//      event and spammed a supplier with a separate template per product
//      (confirmed live: 5 back-to-back WhatsApp messages for 5 items).
//      DAILY suppliers don't need this at all: their next cadence
//      check-in is at most 24h away and already re-asks about everything,
//      stale or not, so a same-day digest would just be a redundant
//      second message — the exact problem this replaces.
//   3. Reminders (2h) / timeouts (24h) for checks nobody's answered yet.
//
// WhatsApp window rule (already documented in lib/samvaadik/adapter.js):
// a business-initiated conversation can only ever be OPENED with an
// approved template, never free text — and a template send does NOT
// itself grant permission to follow up with free text, only the
// recipient's own reply does. So dispatch here sends ONLY a short
// template (the window opener) and creates the SupplierCheck with its
// full item list already in the DB; the itemized list itself gets
// relayed by the Supplier Agent's own first reply once the supplier
// responds (see supplierAgentConfig.js's system prompt in golfcare-backend)
// — not sent from here. Reminders hit the same rule (no reply ever came,
// so the window never opened) and also go out as a template.

const cron = require("node-cron");
const { prisma } = require("../lib/prisma");
const { resolveSupplierConversation } = require("../lib/resolveSupplierConversation");
const { sendTemplate, sendText } = require("../lib/samvaadik/adapter");

const TIMEZONE = process.env.SCHEDULER_TIMEZONE || "Asia/Kolkata";
const CHECKIN_TEMPLATE_NAME = process.env.SUPPLIER_CHECKIN_TEMPLATE_NAME || "";
const REMINDER_TEMPLATE_NAME =
  process.env.SUPPLIER_CHECKIN_REMINDER_TEMPLATE_NAME || CHECKIN_TEMPLATE_NAME;
const REMINDER_HOURS = Number(process.env.SUPPLIER_CHECK_REMINDER_HOURS || 2);
const TIMEOUT_HOURS = Number(process.env.SUPPLIER_CHECK_TIMEOUT_HOURS || 24);
const STAFF_ESCALATION_WA_PHONE = process.env.STAFF_ESCALATION_WA_PHONE || "";
// Once-a-day hour for the on-demand digest (WEEKLY suppliers only — see
// header). Deliberately not tied to any supplier's own checkHour.
const ON_DEMAND_DIGEST_HOUR = Number(process.env.SUPPLIER_ON_DEMAND_DIGEST_HOUR || 12);

const CADENCE_HOURS = { DAILY: 24, WEEKLY: 168 };
const CADENCE_CHECK_TYPE = { DAILY: "SCHEDULED_DAILY", WEEKLY: "SCHEDULED_WEEKLY" };
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getLocalHourAndDay(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(new Date());
  const hourRaw = parts.find((p) => p.type === "hour").value;
  const weekday = parts.find((p) => p.type === "weekday").value;
  return {
    hour: hourRaw === "24" ? 0 : Number(hourRaw), // some locales report midnight as "24"
    dayOfWeek: WEEKDAY_INDEX[weekday],
  };
}

function buildPendingItems(supplierProducts) {
  return supplierProducts.map((sp) => ({
    supplierProductId: sp.id,
    productId: sp.productId,
    variantId: sp.variantId,
    sku: sp.supplierSku || sp.Variant?.sku || null,
    productTitle: sp.Product?.title || "Unknown product",
    variantTitle: sp.Variant?.title || null,
  }));
}

async function sendCheckinOpener(supplier, itemCount, { isReminder = false } = {}) {
  const templateName = isReminder ? REMINDER_TEMPLATE_NAME : CHECKIN_TEMPLATE_NAME;
  if (!templateName) {
    throw new Error(
      `${isReminder ? "SUPPLIER_CHECKIN_REMINDER_TEMPLATE_NAME/" : ""}SUPPLIER_CHECKIN_TEMPLATE_NAME is not configured`,
    );
  }
  // Assumed template shape: {{1}} = supplier name, {{2}} = item count.
  // Whoever creates the actual approved template in Samvaadik should
  // match this parameter order, or this call needs updating to match.
  return sendTemplate(supplier.waPhone, templateName, [supplier.name, String(itemCount)]);
}

async function dispatchCadenceChecks() {
  const { hour, dayOfWeek } = getLocalHourAndDay(TIMEZONE);

  const suppliers = await prisma.supplier.findMany({
    where: {
      isActive: true,
      checkCadence: { in: ["DAILY", "WEEKLY"] },
      checkHour: hour,
    },
  });

  let dispatched = 0;
  for (const supplier of suppliers) {
    if (supplier.checkCadence === "WEEKLY" && supplier.checkDayOfWeek !== dayOfWeek) {
      continue;
    }

    const cadenceHours = CADENCE_HOURS[supplier.checkCadence];
    const checkType = CADENCE_CHECK_TYPE[supplier.checkCadence];
    const lookbackCutoff = new Date(Date.now() - (cadenceHours - 1) * 60 * 60 * 1000);

    const alreadySent = await prisma.supplierCheck.findFirst({
      where: { supplierId: supplier.id, type: checkType, sentAt: { gte: lookbackCutoff } },
      select: { id: true },
    });
    if (alreadySent) continue;

    const supplierProducts = await prisma.supplierProduct.findMany({
      where: { supplierId: supplier.id },
      include: { Variant: true, Product: true },
    });
    if (supplierProducts.length === 0) continue; // nothing assigned to this supplier to check

    const items = buildPendingItems(supplierProducts);

    try {
      await sendCheckinOpener(supplier, items.length);
    } catch (err) {
      console.error(
        `[job] supplier check dispatch: template send failed for supplier ${supplier.id}:`,
        err.message,
      );
      continue; // will be retried next time this supplier's checkHour comes around
    }

    const conversation = await resolveSupplierConversation(supplier);
    await prisma.supplierCheck.create({
      data: {
        supplierId: supplier.id,
        type: checkType,
        status: "SENT",
        items,
        sentAt: new Date(),
        rawReplies: {},
      },
    });
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTBOUND",
        sender: "SYSTEM",
        type: "template",
        templateName: CHECKIN_TEMPLATE_NAME,
        createdAt: new Date(),
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });

    dispatched += 1;
  }
  return dispatched;
}

// Once-daily, WEEKLY-suppliers-only batch (see header for why DAILY
// suppliers are excluded entirely). Pulls directly off current
// AvailabilityState.status rather than consuming module 2's TTL-sweep
// events one at a time — every stale variant a supplier owns is state,
// not a queue, so this just asks "what's stale for this supplier right
// now" and sends ONE message for all of it, instead of firing once per
// expiry event as the previous version did.
async function dispatchOnDemandChecks() {
  const { hour } = getLocalHourAndDay(TIMEZONE);
  if (hour !== ON_DEMAND_DIGEST_HOUR) return 0;

  const suppliers = await prisma.supplier.findMany({
    where: { isActive: true, checkCadence: "WEEKLY" },
  });

  let dispatched = 0;
  for (const supplier of suppliers) {
    const dedupCutoff = new Date(Date.now() - 23 * 60 * 60 * 1000);
    const alreadySentToday = await prisma.supplierCheck.findFirst({
      where: { supplierId: supplier.id, type: "ON_DEMAND", sentAt: { gte: dedupCutoff } },
      select: { id: true },
    });
    if (alreadySentToday) continue;

    const staleSupplierProducts = await prisma.supplierProduct.findMany({
      where: {
        supplierId: supplier.id,
        Variant: { AvailabilityState: { status: "UNKNOWN" } },
      },
      include: { Variant: true, Product: true },
    });
    if (staleSupplierProducts.length === 0) continue; // nothing overdue today

    const items = buildPendingItems(staleSupplierProducts);

    try {
      await sendCheckinOpener(supplier, items.length);
    } catch (err) {
      console.error(
        `[job] supplier check dispatch: on-demand digest send failed for supplier ${supplier.id}:`,
        err.message,
      );
      continue;
    }

    const conversation = await resolveSupplierConversation(supplier);
    await prisma.supplierCheck.create({
      data: {
        supplierId: supplier.id,
        type: "ON_DEMAND",
        status: "SENT",
        items,
        sentAt: new Date(),
        rawReplies: {},
      },
    });
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTBOUND",
        sender: "SYSTEM",
        type: "template",
        templateName: CHECKIN_TEMPLATE_NAME,
        createdAt: new Date(),
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });

    dispatched += 1;
  }
  return dispatched;
}

async function sendRemindersAndTimeouts() {
  const timeoutCutoff = new Date(Date.now() - TIMEOUT_HOURS * 60 * 60 * 1000);
  const reminderCutoff = new Date(Date.now() - REMINDER_HOURS * 60 * 60 * 1000);

  const openChecks = await prisma.supplierCheck.findMany({
    where: { status: "SENT", sentAt: { lte: reminderCutoff } },
    include: { Supplier: true },
  });

  let remindersSent = 0;
  let timedOut = 0;

  for (const check of openChecks) {
    if (check.sentAt <= timeoutCutoff) {
      await prisma.supplierCheck.update({
        where: { id: check.id },
        data: { status: "TIMED_OUT" },
      });
      await prisma.auditLog.create({
        data: {
          actorType: "SYSTEM",
          action: "supplier_check_timed_out",
          entityType: "SupplierCheck",
          entityId: check.id,
          beforeState: { status: "SENT" },
          afterState: { status: "TIMED_OUT", supplierId: check.supplierId },
          source: "supplier_check_dispatch",
        },
      });
      timedOut += 1;

      if (STAFF_ESCALATION_WA_PHONE) {
        try {
          await sendText(
            STAFF_ESCALATION_WA_PHONE,
            `Supplier check-in timed out (no reply in ${TIMEOUT_HOURS}h): ${check.Supplier?.name || check.supplierId}.`,
          );
        } catch (err) {
          console.error(
            `[job] supplier check dispatch: staff escalation notify failed:`,
            err.message,
          );
        }
      }
      continue;
    }

    const alreadyReminded = Boolean(check.rawReplies?.reminderSentAt);
    if (alreadyReminded) continue;

    try {
      await sendCheckinOpener(check.Supplier, (check.items || []).length, { isReminder: true });
    } catch (err) {
      console.error(
        `[job] supplier check dispatch: reminder send failed for check ${check.id}:`,
        err.message,
      );
      continue;
    }

    await prisma.supplierCheck.update({
      where: { id: check.id },
      data: {
        rawReplies: { ...(check.rawReplies || {}), reminderSentAt: new Date().toISOString() },
      },
    });
    remindersSent += 1;
  }

  return { remindersSent, timedOut };
}

let isRunning = false;

function registerSupplierCheckDispatchJob() {
  cron.schedule("*/15 * * * *", async () => {
    if (isRunning) {
      console.log("[job] supplier check dispatch already running, skipping this tick.");
      return;
    }
    isRunning = true;
    try {
      const cadenceDispatched = await dispatchCadenceChecks();
      const onDemandDispatched = await dispatchOnDemandChecks();
      const { remindersSent, timedOut } = await sendRemindersAndTimeouts();
      console.log(
        `[job] supplier check dispatch complete — cadence:${cadenceDispatched} on-demand:${onDemandDispatched} reminders:${remindersSent} timed-out:${timedOut}.`,
      );
    } catch (err) {
      console.error("[job] supplier check dispatch failed:", err.message);
    } finally {
      isRunning = false;
    }
  });
}

module.exports = {
  registerSupplierCheckDispatchJob,
  dispatchCadenceChecks,
  dispatchOnDemandChecks,
  sendRemindersAndTimeouts,
};
