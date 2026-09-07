//src/jobs/supplierCheckDispatch.js
//
// Module 5.1 — supplier stock check-in lifecycle. Three concerns, one
// tick, one isRunning guard (same pattern as shopifyReconciliation.js):
//   1. Cadence dispatch — suppliers due per their DAILY/WEEKLY schedule.
//   2. On-demand dispatch — variants module 2's TTL sweep flagged via
//      `availability.recheck_needed` events.
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

// Consumes module 2's `availability.recheck_needed` events (emitted by the
// TTL decay sweep — see availabilityDecay.js) for variants with a primary
// supplier. Dedup window matches TIMEOUT_HOURS: don't re-dispatch an
// on-demand check for the same supplier+variant if one's already out and
// hasn't timed out yet.
async function dispatchOnDemandChecks() {
  const since = new Date(Date.now() - 20 * 60 * 1000); // job runs every 15 min; small overlap for safety
  const events = await prisma.event.findMany({
    where: { type: "availability.recheck_needed", occurredAt: { gte: since } },
    orderBy: { occurredAt: "desc" },
    take: 50,
  });

  let dispatched = 0;
  for (const event of events) {
    const { variantId, supplierId } = event.payload || {};
    if (!variantId || !supplierId) continue;

    const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier || !supplier.isActive) continue;

    const recentCutoff = new Date(Date.now() - TIMEOUT_HOURS * 60 * 60 * 1000);
    const recentChecks = await prisma.supplierCheck.findMany({
      where: { supplierId, type: "ON_DEMAND", sentAt: { gte: recentCutoff } },
      select: { items: true },
    });
    const alreadyCovered = recentChecks.some((c) =>
      (c.items || []).some((item) => item.variantId === variantId),
    );
    if (alreadyCovered) continue;

    const supplierProduct = await prisma.supplierProduct.findFirst({
      where: { supplierId, variantId },
      include: { Variant: true, Product: true },
    });
    if (!supplierProduct) continue;

    const items = buildPendingItems([supplierProduct]);

    try {
      await sendCheckinOpener(supplier, items.length);
    } catch (err) {
      console.error(
        `[job] supplier check dispatch: on-demand template send failed for supplier ${supplierId}:`,
        err.message,
      );
      continue;
    }

    const conversation = await resolveSupplierConversation(supplier);
    await prisma.supplierCheck.create({
      data: {
        supplierId,
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
