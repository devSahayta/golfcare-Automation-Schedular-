// src/lib/email/sendBulkImportDigestEmail.js
//
// ONE email per finished bulk-import batch, not one per product draft —
// a 200-item catalog would otherwise flood the approval inbox the exact
// way the backend's existing SUPPLIER_BULK_NEW_PRODUCT_LIMIT cap already
// guards against for the one-by-one flow (see supplierAgentTools.js).
// Each drafted item still gets a real ProductDraft row with its own
// approvalToken — reviewing/approving those individually (or in bulk) is
// frontend work for later; this email is just the "it's done, here's
// what happened" notification. Same Resend pattern as
// sendDynamicTemplateApprovalEmail.js, duplicated per this repo's
// cross-repo convention.

const { Resend } = require("resend");

let client = null;
function getClient() {
  if (!process.env.EMAIL_PROVIDER_API_KEY) {
    throw new Error("Missing EMAIL_PROVIDER_API_KEY env var.");
  }
  if (!client) client = new Resend(process.env.EMAIL_PROVIDER_API_KEY);
  return client;
}

function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/**
 * @param {object} input
 * @param {string} input.supplierName
 * @param {number} input.totalItems
 * @param {{title: string, token: string}[]} input.draftedItems - still
 *   needs per-item approval; links listed below since there's no bulk
 *   review page yet (deferred frontend work)
 * @param {number} input.linkedCount
 * @param {number} input.failedCount
 * @param {{title: string, brand: string|null, category: string|null}[]} [input.needsRateItems] -
 *   held back because no margin/GST rate rule matched them — not drafted,
 *   not guessed at. See ProductImportItem.NEEDS_RATE.
 * @param {{title: string, brand: string|null, category: string|null}[]} [input.needsBrandReviewItems] -
 *   held back because the brand isn't on this supplier's allowed brands
 *   list (or couldn't be identified at all). See ProductImportItem.NEEDS_BRAND_REVIEW.
 */
async function sendBulkImportDigestEmail({ supplierName, totalItems, draftedItems, linkedCount, failedCount, needsRateItems, needsBrandReviewItems }) {
  const staffApprovalEmail = process.env.STAFF_APPROVAL_EMAIL;
  if (!staffApprovalEmail) {
    throw new Error("Missing STAFF_APPROVAL_EMAIL env var.");
  }
  const approvalLinkBaseUrl = process.env.APPROVAL_LINK_BASE_URL || "http://localhost:4000";
  const items = draftedItems || [];
  const needsRate = needsRateItems || [];
  const needsBrandReview = needsBrandReviewItems || [];

  const linksHtml = items.length
    ? `<ol style="color:#333;padding-left:20px;">${items
        .map(
          (i) =>
            `<li style="margin-bottom:4px;">${escapeHtml(i.title)} — <a href="${approvalLinkBaseUrl}/api/product-drafts/${i.token}">review</a></li>`,
        )
        .join("")}</ol>`
    : "<p style=\"color:#666;\">No new drafts — every item matched something already in the catalog.</p>";

  const needsRateHtml = needsRate.length
    ? `<p style="color:#444;">These weren't drafted because no margin/GST rate covered them — ask the supplier for a rate and these can be resubmitted:</p>
       <ul style="color:#333;padding-left:20px;">${needsRate
         .map((i) => `<li>${escapeHtml(i.title)}${i.brand || i.category ? ` <span style="color:#888;">(${escapeHtml([i.brand, i.category].filter(Boolean).join(" · "))})</span>` : ""}</li>`)
         .join("")}</ul>`
    : "";

  const needsBrandReviewHtml = needsBrandReview.length
    ? `<p style="color:#444;">These weren't drafted because the brand isn't on this supplier's allowed brands list (or couldn't be identified) — confirm with the supplier and either update their Supplier.brands or resubmit under the right brand:</p>
       <ul style="color:#333;padding-left:20px;">${needsBrandReview
         .map((i) => `<li>${escapeHtml(i.title)}${i.brand || i.category ? ` <span style="color:#888;">(${escapeHtml([i.brand, i.category].filter(Boolean).join(" · "))})</span>` : ""}</li>`)
         .join("")}</ul>`
    : "";

  const html = `
    <div style="font-family: sans-serif; max-width: 560px;">
      <h2>Bulk product import finished</h2>
      <p><strong>${escapeHtml(supplierName)}</strong> &middot; ${totalItems} item(s) processed</p>
      <ul style="color:#333;">
        <li>${items.length} new product draft(s) created — pending review, links below</li>
        <li>${linkedCount} already existed — linked to this supplier and stock updated instead of duplicating</li>
        ${needsRate.length > 0 ? `<li style="color:#b45309;">${needsRate.length} held back — no margin/GST rate matched them, see below</li>` : ""}
        ${needsBrandReview.length > 0 ? `<li style="color:#b45309;">${needsBrandReview.length} held back — brand not approved for this supplier, see below</li>` : ""}
        ${failedCount > 0 ? `<li style="color:#b91c1c;">${failedCount} failed — check ProductImportItem.errorMessage for details</li>` : ""}
      </ul>
      <p style="color:#666;font-size:13px;">Each link below approves/rejects that one product individually, same as any other product draft — a bulk review page is planned but not built yet.</p>
      ${linksHtml}
      ${needsRateHtml}
      ${needsBrandReviewHtml}
    </div>
  `;

  const resend = getClient();
  await resend.emails.send({
    from: process.env.EMAIL_FROM_ADDRESS,
    to: [staffApprovalEmail],
    subject: `Bulk import finished: ${supplierName} (${items.length} new, ${linkedCount} existing${needsRate.length > 0 ? `, ${needsRate.length} need rate` : ""}${needsBrandReview.length > 0 ? `, ${needsBrandReview.length} need brand review` : ""}${failedCount > 0 ? `, ${failedCount} failed` : ""})`,
    html,
  });

  return { sentTo: staffApprovalEmail };
}

module.exports = { sendBulkImportDigestEmail };
