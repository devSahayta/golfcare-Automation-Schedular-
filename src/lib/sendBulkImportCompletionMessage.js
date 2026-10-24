// src/lib/sendBulkImportCompletionMessage.js
//
// The supplier's own WhatsApp confirmation once their bulk-import batch
// finishes — sendBulkImportDigestEmail.js (same directory's sibling)
// already notifies STAFF, but until now the supplier who actually sent
// the catalog never heard back at all, unlike the one-by-one flow's
// immediate "draft created" reply. Now that EVERY document submission
// goes through this pipeline (not just 15+-item ones — see
// supplierAgentConfig.js, backend repo), including small/fast batches,
// that gap matters a lot more than it used to.
//
// Freeform text (sendText), not a template — no approved Meta template
// exists for this and getting one has real lead time. sendText can 403 if
// the supplier's 24h WhatsApp window has closed (documented in
// samvaadik/adapter.js — its real gate differs from getSessionWindow's
// heuristic); accepted as a known gap for now rather than solved with a
// new template. Best-effort from the caller's side, same posture as
// sendBulkImportDigestEmail: this throws on failure, finalizeBatchIfComplete
// (productImportDrain.js) logs-and-continues rather than let a failed
// WhatsApp send block the batch being marked DONE.

const { prisma } = require("./prisma");
const { resolveSupplierConversation } = require("./resolveSupplierConversation");
const { sendText } = require("./samvaadik/adapter");

function plural(n) {
  return n === 1 ? "" : "s";
}

function buildBody({ supplierName, draftedCount, linkedCount, needsRateCount }) {
  const lines = [
    `Hi ${supplierName}! Your product list is done processing ✅`,
    "",
    `${draftedCount} new product${plural(draftedCount)} added as draft${plural(draftedCount)}, pending our review`,
    `${linkedCount} already existed in our catalog — linked to your account`,
  ];
  if (needsRateCount > 0) {
    // Informational only — no confirmed way today for a supplier's later
    // WhatsApp reply to automatically unstick an already-NEEDS_RATE item,
    // so this doesn't ask them to reply, just sets the expectation.
    lines.push(`${needsRateCount} item${plural(needsRateCount)} on hold, waiting on margin/GST info — we'll follow up on pricing for those`);
  }
  lines.push("", "Thanks for sending the list!");
  return lines.join("\n");
}

/**
 * @param {object} input
 * @param {object} input.supplier - needs .id, .name, .waPhone
 * @param {number} input.draftedCount
 * @param {number} input.linkedCount
 * @param {number} input.needsRateCount
 */
async function sendBulkImportCompletionMessage({ supplier, draftedCount, linkedCount, needsRateCount }) {
  const body = buildBody({ supplierName: supplier.name, draftedCount, linkedCount, needsRateCount });

  await sendText(supplier.waPhone, body);

  const conversation = await resolveSupplierConversation(supplier);
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      sender: "SYSTEM",
      type: "text",
      body,
    },
  });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });

  return { sentTo: supplier.waPhone };
}

module.exports = { sendBulkImportCompletionMessage };
