// src/lib/resolveCustomerConversation.js
//
// Customer-side counterpart to resolveSupplierConversation.js — same
// reasoning throughout (mirrors golfcare-backend's
// webhooks/lib/resolveConversation.js Customer branch, cross-repo
// duplication since these are separate deployables). Used by Module 6's
// campaignTriggerEval.js so every Lifecycle Agent send logs into the same
// Message/Conversation trail as everything else, instead of going out
// with no local record at all.
//
// Same sessionExpiresAt divergence as resolveSupplierConversation.js: the
// scheduler is the one initiating contact here (birthday/replenishment/
// cross-sell are all proactive), not responding to an inbound message, so
// a freshly created conversation gets sessionExpiresAt: null until the
// customer actually replies and the backend's webhook takes over.

const { prisma } = require("./prisma");

async function resolveCustomerConversation(customer) {
  const existing = await prisma.conversation.findFirst({
    where: {
      customerId: customer.id,
      OR: [
        { sessionExpiresAt: null },
        { sessionExpiresAt: { gt: new Date() } },
      ],
    },
    orderBy: { lastMessageAt: "desc" },
  });
  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      customerId: customer.id,
      waPhone: customer.waPhone,
      state: "AI_HANDLING",
      lastMessageAt: new Date(),
      sessionExpiresAt: null,
    },
  });
}

module.exports = { resolveCustomerConversation };
