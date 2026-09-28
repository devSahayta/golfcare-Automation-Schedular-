//src/jobs/campaignTriggerEval.js
//
// Module 6 — evaluates three trigger scenarios per tick, same isRunning
// guard + multi-step-in-one-job pattern as supplierCheckDispatch.js:
//   1. Birthday (static lane) — GolferProfile.dob matches today.
//   2. Replenishment (static lane) — last order of a consumable product
//      was ~Product.replenishDays days ago.
//   3. Cross-sell (dynamic lane) — last order included a Product with a
//      non-empty upsellPath, ~CROSS_SELL_DELAY_DAYS days ago. Drafts a
//      one-off personalized template via Claude, creates a PENDING
//      DynamicTemplate + emails a human for approval — nothing gets sent
//      to the customer until that approval + Meta's own approval happen
//      (see templateStatusPoll.js).
//
// Static lane (birthday/replenishment) never calls Claude — it's a fixed
// message shape, filled from a pre-approved, reusable template name
// (BIRTHDAY_TEMPLATE_NAME / REPLENISHMENT_TEMPLATE_NAME). If the customer's
// 24h window happens to be open, sends freeform text instead (cheaper,
// more natural) — but per lib/samvaadik/adapter.js's getSessionWindow
// docstring, that check alone isn't authoritative, so a 403 from the real
// sendText call is treated as the fallback signal to use the template
// instead, not just trusted blind.
//
// Review-reminder and WINBACK/CUSTOM scenarios are explicitly out of
// scope this pass (see the Module 6 plan) — Order.deliveredAt exists now
// for a later pass to use, but no trigger logic reads it yet.

const crypto = require("crypto");
const cron = require("node-cron");
const { prisma } = require("../lib/prisma");
const { resolveCustomerConversation } = require("../lib/resolveCustomerConversation");
const { sendText, sendTemplate, getSessionWindow } = require("../lib/samvaadik/adapter");
const { draftDynamicTemplate } = require("../lib/claude/draftDynamicTemplate");
const { sendDynamicTemplateApprovalEmail } = require("../lib/email/sendDynamicTemplateApprovalEmail");

const TIMEZONE = process.env.SCHEDULER_TIMEZONE || "Asia/Kolkata";
const BIRTHDAY_TEMPLATE_NAME = process.env.BIRTHDAY_TEMPLATE_NAME || "";
const REPLENISHMENT_TEMPLATE_NAME = process.env.REPLENISHMENT_TEMPLATE_NAME || "";
const CROSS_SELL_DELAY_DAYS = Number(process.env.CROSS_SELL_DELAY_DAYS || 14);
const PRODUCT_DRAFT_TOKEN_EXPIRY_DAYS = Number(process.env.PRODUCT_DRAFT_TOKEN_EXPIRY_DAYS || 7);
// How wide a window (either side of the exact target day) each tick's
// day-level match counts as "due" — this job runs every 30 min, so a
// ±1-day window comfortably covers that without needing sub-day precision
// in the queries themselves.
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Applied consistently to both "today" and a stored dob — avoids a subtle
// mismatch where "today" is computed in SCHEDULER_TIMEZONE but dob's
// month/day is read via getUTCMonth/getUTCDate (a different zone), which
// could shift a birthday by a day right around midnight UTC.
function getDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

async function alreadyTriggeredThisYear(customerId, scenario, sinceYear) {
  const yearStart = new Date(Date.UTC(sinceYear, 0, 1));
  const existing = await prisma.campaignTrigger.findFirst({
    where: { customerId, scenario, detectedAt: { gte: yearStart } },
    select: { id: true },
  });
  return Boolean(existing);
}

async function alreadyTriggeredRecently(customerId, scenario, withinDays) {
  const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000);
  const existing = await prisma.campaignTrigger.findFirst({
    where: { customerId, scenario, detectedAt: { gte: cutoff } },
    select: { id: true },
  });
  return Boolean(existing);
}

// Static-lane send: try freeform text if the window looks open, fall back
// to the pre-approved template either when it's not, or when sendText
// itself rejects with the 403 nuance getSessionWindow can't see (see
// adapter.js's getSessionWindow docstring).
async function sendStaticMessage(customer, freeformText, templateName, templateVars) {
  let windowOpen = false;
  try {
    const window = await getSessionWindow(customer.waPhone);
    windowOpen = window.sessionOpen;
  } catch (err) {
    console.error(`[job] campaignTriggerEval: session-window check failed for ${customer.id}:`, err.message);
  }

  if (windowOpen) {
    try {
      const result = await sendText(customer.waPhone, freeformText);
      return { ...result, usedTemplateName: null };
    } catch (err) {
      console.warn(
        `[job] campaignTriggerEval: sendText rejected despite open window for ${customer.id} (${err.message}), falling back to template.`,
      );
    }
  }

  if (!templateName) {
    throw new Error(`No template name configured for this scenario.`);
  }
  const result = await sendTemplate(customer.waPhone, templateName, templateVars);
  return { ...result, usedTemplateName: templateName };
}

// templateName is null for a freeform sendText — matches Message.type
// staying "template" either way (this row represents "an outbound
// SYSTEM-initiated send," not literally always a WhatsApp template
// message), same convention supplierCheckDispatch.js already uses.
//
// UNLIKE supplierCheckDispatch.js's own opener Message (deliberately
// body: null, since a check-in opener carries no content the model needs —
// the pendingCheck system-prompt section already tells it everything),
// this one gets a REAL body: a birthday/replenishment message genuinely
// says something a customer might reply to, and agentEngine/index.js
// filters out any SYSTEM-sender row with no body from the model's own
// conversation history (`m.sender !== "SYSTEM" || m.body`) — leaving it
// null would make this send invisible to Sales Agent when the customer
// replies. body is our own locally-composed wording even when the
// TEMPLATE path actually sent (Meta's exact approved copy isn't fetched
// back), but it's an accurate-enough record of what the customer saw.
//
// Also tags Conversation.intent so Sales Agent's system prompt can call
// this out explicitly on the customer's next reply, on top of it being
// visible in raw history — see salesAgentConfig.js's campaign-reply
// section and agentEngine/index.js, which clears this tag after it's
// been surfaced once.
async function logSendAndCloseTrigger({ customer, trigger, status, templateName, body, scenario }) {
  const conversation = await resolveCustomerConversation(customer);
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      sender: "SYSTEM",
      type: "template",
      templateName: templateName || null,
      body: body || null,
      createdAt: new Date(),
    },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date(), intent: `campaign_reply:${scenario}` },
  });
  await prisma.campaignTrigger.update({ where: { id: trigger.id }, data: { status } });
}

async function evaluateBirthdays() {
  const { year, month, day } = getDateParts(new Date(), TIMEZONE);
  let dispatched = 0;

  const profiles = await prisma.golferProfile.findMany({
    where: { dob: { not: null } },
    include: { Customer: true },
  });

  for (const profile of profiles) {
    const dobParts = getDateParts(profile.dob, TIMEZONE);
    if (dobParts.month !== month || dobParts.day !== day) continue;

    const customer = profile.Customer;
    if (await alreadyTriggeredThisYear(customer.id, "BIRTHDAY", year)) continue;

    const trigger = await prisma.campaignTrigger.create({
      data: { customerId: customer.id, scenario: "BIRTHDAY", status: "PENDING" },
    });

    if (!customer.consentMarketing) {
      await prisma.campaignTrigger.update({
        where: { id: trigger.id },
        data: { status: "SUPPRESSED", suppressedReason: "no_marketing_consent" },
      });
      continue;
    }

    const firstName = customer.firstName || "there";
    const messageBody = `Happy Birthday, ${firstName}! 🎉 Wishing you a great year ahead, on and off the course. — Golf Care`;
    try {
      const sendResult = await sendStaticMessage(customer, messageBody, BIRTHDAY_TEMPLATE_NAME, [firstName]);
      await logSendAndCloseTrigger({
        customer,
        trigger,
        status: "SENT",
        templateName: sendResult.usedTemplateName,
        body: messageBody,
        scenario: "BIRTHDAY",
      });
      dispatched += 1;
    } catch (err) {
      console.error(`[job] campaignTriggerEval: birthday send failed for ${customer.id}:`, err.message);
      await prisma.campaignTrigger.update({
        where: { id: trigger.id },
        data: { status: "SUPPRESSED", suppressedReason: `send_failed: ${err.message}`.slice(0, 250) },
      });
    }
  }

  return dispatched;
}

async function evaluateReplenishment() {
  let dispatched = 0;

  const consumableProducts = await prisma.product.findMany({
    where: { isConsumable: true, replenishDays: { not: null } },
    select: { id: true, shopifyProductId: true, title: true, replenishDays: true },
  });
  if (consumableProducts.length === 0) return 0;
  const byShopifyId = new Map(consumableProducts.map((p) => [p.shopifyProductId, p]));

  const customers = await prisma.customer.findMany({
    where: { consentMarketing: true, lastOrderAt: { not: null } },
    include: { Order: { orderBy: { placedAt: "desc" }, take: 5 } },
  });

  for (const customer of customers) {
    for (const order of customer.Order) {
      const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
      const consumableLine = lineItems.find((li) => byShopifyId.has(String(li.product_id)));
      if (!consumableLine) continue;

      const product = byShopifyId.get(String(consumableLine.product_id));
      const dueAt = new Date(order.placedAt.getTime() + product.replenishDays * 24 * 60 * 60 * 1000);
      const isDue = Math.abs(Date.now() - dueAt.getTime()) <= DAY_WINDOW_MS;
      if (!isDue) continue;

      if (await alreadyTriggeredRecently(customer.id, "REPLENISHMENT", product.replenishDays)) continue;

      const trigger = await prisma.campaignTrigger.create({
        data: { customerId: customer.id, scenario: "REPLENISHMENT", status: "PENDING" },
      });

      const firstName = customer.firstName || "there";
      const messageBody = `Hi ${firstName}, just checking in — running low on ${product.title}? Reply here or tap below to reorder. — Golf Care`;
      try {
        const sendResult = await sendStaticMessage(customer, messageBody, REPLENISHMENT_TEMPLATE_NAME, [
          firstName,
          product.title,
        ]);
        await logSendAndCloseTrigger({
          customer,
          trigger,
          status: "SENT",
          templateName: sendResult.usedTemplateName,
          body: messageBody,
          scenario: "REPLENISHMENT",
        });
        dispatched += 1;
      } catch (err) {
        console.error(`[job] campaignTriggerEval: replenishment send failed for ${customer.id}:`, err.message);
        await prisma.campaignTrigger.update({
          where: { id: trigger.id },
          data: { status: "SUPPRESSED", suppressedReason: `send_failed: ${err.message}`.slice(0, 250) },
        });
      }
      break; // one replenishment trigger per customer per tick is enough
    }
  }

  return dispatched;
}

function normalizeTemplateName(raw) {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 100);
}

async function evaluateCrossSell() {
  let drafted = 0;

  const upsellProducts = await prisma.product.findMany({
    where: { upsellPath: { isEmpty: false } },
    select: { id: true, shopifyProductId: true, title: true, upsellPath: true },
  });
  if (upsellProducts.length === 0) return 0;
  const byShopifyId = new Map(upsellProducts.map((p) => [p.shopifyProductId, p]));

  const targetProducts = await prisma.product.findMany({
    select: { id: true, title: true },
  });
  const byId = new Map(targetProducts.map((p) => [p.id, p]));

  const customers = await prisma.customer.findMany({
    where: { consentMarketing: true, lastOrderAt: { not: null } },
    include: { Order: { orderBy: { placedAt: "desc" }, take: 5 } },
  });

  for (const customer of customers) {
    for (const order of customer.Order) {
      const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
      const upsellLine = lineItems.find((li) => byShopifyId.has(String(li.product_id)));
      if (!upsellLine) continue;

      const purchasedProduct = byShopifyId.get(String(upsellLine.product_id));
      const dueAt = new Date(order.placedAt.getTime() + CROSS_SELL_DELAY_DAYS * 24 * 60 * 60 * 1000);
      const isDue = Math.abs(Date.now() - dueAt.getTime()) <= DAY_WINDOW_MS;
      if (!isDue) continue;

      if (await alreadyTriggeredRecently(customer.id, "CROSS_SELL", CROSS_SELL_DELAY_DAYS * 2)) continue;

      const targetProductId = purchasedProduct.upsellPath[0];
      const targetProduct = byId.get(targetProductId);
      if (!targetProduct) continue; // upsellPath points at a product id we don't recognize — skip rather than guess

      const trigger = await prisma.campaignTrigger.create({
        data: { customerId: customer.id, scenario: "CROSS_SELL", status: "PENDING" },
      });

      const firstName = customer.firstName || "there";
      try {
        const draft = await draftDynamicTemplate({
          scenario: "CROSS_SELL",
          customerFirstName: firstName,
          productTitle: targetProduct.title,
          productUpsellContext: `Customer bought "${purchasedProduct.title}" ${CROSS_SELL_DELAY_DAYS} days ago — this pairs well with it.`,
        });

        if (!draft.bodyText || draft.variables.length === 0) {
          throw new Error("Claude draft came back empty/unparseable");
        }

        const templateName = normalizeTemplateName(
          `cross_sell_${customer.id.slice(0, 8)}_${Date.now()}`,
        );
        const approvalToken = crypto.randomBytes(24).toString("hex");
        const tokenExpiresAt = new Date(
          Date.now() + PRODUCT_DRAFT_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
        );

        const dynamicTemplate = await prisma.dynamicTemplate.create({
          data: {
            customerId: customer.id,
            campaignTriggerId: trigger.id,
            scenario: "CROSS_SELL",
            templateName,
            category: draft.category,
            bodyDraft: draft.bodyText,
            variables: draft.variables,
            approvalToken,
            tokenExpiresAt,
            draftInputTokens: draft.usage.inputTokens,
            draftOutputTokens: draft.usage.outputTokens,
            draftCostUsd: draft.cost.usd,
            draftCostInr: draft.cost.inr,
          },
        });

        await sendDynamicTemplateApprovalEmail({
          token: approvalToken,
          scenario: "CROSS_SELL",
          bodyText: draft.bodyText,
          variables: draft.variables,
          category: draft.category,
          customerName: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || customer.waPhone,
        });
        await prisma.dynamicTemplate.update({
          where: { id: dynamicTemplate.id },
          data: { emailSentTo: process.env.STAFF_APPROVAL_EMAIL, emailSentAt: new Date() },
        });

        await prisma.campaignTrigger.update({ where: { id: trigger.id }, data: { status: "TEMPLATE_CREATED" } });
        drafted += 1;
      } catch (err) {
        console.error(`[job] campaignTriggerEval: cross-sell draft failed for ${customer.id}:`, err.message);
        await prisma.campaignTrigger.update({
          where: { id: trigger.id },
          data: { status: "SUPPRESSED", suppressedReason: `draft_failed: ${err.message}`.slice(0, 250) },
        });
      }
      break; // one cross-sell trigger per customer per tick is enough
    }
  }

  return drafted;
}

let isRunning = false;

function registerCampaignTriggerEvalJob() {
  cron.schedule("*/30 * * * *", async () => {
    if (isRunning) {
      console.log("[job] campaign trigger evaluation already running, skipping this tick.");
      return;
    }
    isRunning = true;
    try {
      const birthdays = await evaluateBirthdays();
      const replenishments = await evaluateReplenishment();
      const crossSells = await evaluateCrossSell();
      console.log(
        `[job] campaign trigger evaluation complete — birthday:${birthdays} replenishment:${replenishments} cross-sell-drafted:${crossSells}.`,
      );
    } catch (err) {
      console.error("[job] campaign trigger evaluation failed:", err.message);
    } finally {
      isRunning = false;
    }
  });
}

module.exports = {
  registerCampaignTriggerEvalJob,
  evaluateBirthdays,
  evaluateReplenishment,
  evaluateCrossSell,
};
