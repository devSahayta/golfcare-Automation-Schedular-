// src/lib/email/sendDynamicTemplateApprovalEmail.js
//
// Module 6 — duplicated from golfcare-backend/src/services/emailService.js's
// Resend pattern (same reasoning as this repo's samvaadik adapter: the
// scheduler is a Render Background Worker with no public HTTP surface of
// its own to serve an approval page from, so the approval LINK points at
// the backend's /api/dynamic-templates/:token page — see
// golfcare-Automation-Backend-/src/controllers/dynamicTemplateController.js
// — but the drafting job here is what actually knows a new template needs
// review, so it's the one sending the notification). Keep in sync with
// emailService.js's HTML/Resend-call shape manually if that ever changes.

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
 * @param {string} input.token - DynamicTemplate.approvalToken
 * @param {string} input.scenario
 * @param {string} input.bodyText
 * @param {string[]} input.variables
 * @param {string} input.category
 * @param {string} [input.imageUrl] - real existing product photo, never AI-generated
 * @param {string} input.customerName
 */
async function sendDynamicTemplateApprovalEmail({
  token,
  scenario,
  bodyText,
  variables,
  category,
  imageUrl,
  customerName,
}) {
  const staffApprovalEmail = process.env.STAFF_APPROVAL_EMAIL;
  if (!staffApprovalEmail) {
    throw new Error("Missing STAFF_APPROVAL_EMAIL env var.");
  }
  const approvalLinkBaseUrl = process.env.APPROVAL_LINK_BASE_URL || "http://localhost:4000";
  const reviewUrl = `${approvalLinkBaseUrl}/api/dynamic-templates/${token}`;

  let previewText = bodyText || "";
  (variables || []).forEach((v, i) => {
    previewText = previewText.replace(`{{${i + 1}}}`, String(v));
  });

  const html = `
    <div style="font-family: sans-serif; max-width: 480px;">
      <h2>New campaign template pending approval</h2>
      <p><strong>${escapeHtml(scenario)}</strong> for ${escapeHtml(customerName)} &middot; ${escapeHtml(category)}</p>
      ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" style="max-width:100%;border-radius:8px;" />` : ""}
      <p>${escapeHtml(previewText)}</p>
      <p style="color:#666;font-size:13px;">AI-drafted for this one customer, will be submitted to Meta for approval, sent once, then deleted — not a reusable template.</p>
      <p>
        <a href="${reviewUrl}" style="display:inline-block;padding:10px 20px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">
          Review this template
        </a>
      </p>
    </div>
  `;

  const resend = getClient();
  await resend.emails.send({
    from: process.env.EMAIL_FROM_ADDRESS,
    to: [staffApprovalEmail],
    subject: `Approve campaign template: ${scenario} for ${customerName}`,
    html,
  });

  return { sentTo: staffApprovalEmail };
}

module.exports = { sendDynamicTemplateApprovalEmail };
