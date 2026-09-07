// src/lib/resolveSupplierConversation.js
//
// Supplier-only find-or-create, mirroring golfcare-backend's
// webhooks/lib/resolveConversation.js (same cross-repo duplication reason
// as lib/shopify.js — separate deployables, can't require() across
// repos). The scheduler only ever dispatches TO suppliers, never
// customers, so this is intentionally narrower than the backend's version
// (no Customer branch).
//
// sessionExpiresAt divergence from the backend's version, deliberately:
// the backend's resolveConversation() is only ever called from an INBOUND
// webhook, so the sender just opened WhatsApp's 24h free-text window —
// setting sessionExpiresAt to now+24h there is correct. Here, the
// scheduler is the one initiating contact (that's why the dispatch job
// must send a template, not free text — see supplierCheckDispatch.js);
// no window is open yet, so a freshly created conversation gets
// sessionExpiresAt: null until the supplier actually replies and the
// backend's webhook handles it.

const { prisma } = require("./prisma");

async function resolveSupplierConversation(supplier) {
  const existing = await prisma.conversation.findFirst({
    where: {
      supplierId: supplier.id,
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
      supplierId: supplier.id,
      waPhone: supplier.waPhone,
      state: "AI_HANDLING",
      lastMessageAt: new Date(),
      sessionExpiresAt: null,
    },
  });
}

module.exports = { resolveSupplierConversation };
