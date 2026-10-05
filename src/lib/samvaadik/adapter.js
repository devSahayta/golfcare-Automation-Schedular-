// src/lib/samvaadik/adapter.js
//
// Single interface to Samvaadik. Nothing else in the codebase should
// call Samvaadik's HTTP API directly — always go through this file.
//
// STATUS (as of this build pass):
//   sendText, sendTemplate, sendInteractive, createTemplate, listTemplates
//     — implemented against Samvaadik's confirmed /v1 API.
//   downloadMedia, parseWebhook, deleteTemplate
//     — genuinely blocked. Each throws a specific, explanatory error
//     rather than a generic "not implemented" — see each function's
//     comment for exactly what's missing and why.
//   getProduct, updateInventory, getOrderStatus
//     — DEPRECATED. Per the team's decision, Shopify access goes directly
//     through golfcare-backend, not through Samvaadik. These are kept as
//     loud-failing stubs (not removed) so nothing silently calls them by
//     accident while other code still references this file's old shape.

const { callSamvaadik } = require("./client");

/**
 * Send a free-form WhatsApp text message.
 * NOTE: Samvaadik enforces WhatsApp's 24-hour messaging window — this call
 * will fail with a 403 (code NO_USER_REPLY / WINDOW_EXPIRED /
 * TEMPLATE_ONLY_WAITING_FOR_USER) if the contact hasn't messaged recently.
 * Use sendTemplate to initiate or re-open a conversation instead.
 *
 * @param {string} to - phone number, digits only (Samvaadik's own format, e.g. "919876543210")
 * @param {string} body - message text
 * @param {{ skipWindowCheck?: boolean }} [options]
 * @returns {Promise<{ waMessageId: string, wmId: string }>}
 */
async function sendText(to, body, options = {}) {
  return callSamvaadik(async (client) => {
    const headers = options.skipWindowCheck
      ? { "x-skip-window-check": "true" }
      : {};
    const res = await client.post(
      "/messages/text",
      { phone: to, message: body },
      { headers },
    );
    return { waMessageId: res.data.wa_message_id, wmId: res.data.wm_id };
  });
}

/**
 * Send a pre-approved WhatsApp template message.
 *
 * NOTE ON `variables`: Samvaadik's template API takes POSITIONAL
 * parameters (an ordered array matching {{1}}, {{2}}... in the template
 * body), not a named Record<string,string> — that's what the API actually
 * accepts, so this deliberately differs from an earlier draft signature.
 * Pass them in order, e.g. ["Rahul", "Order #123"].
 *
 * @param {string} to
 * @param {string} templateName
 * @param {string[]} [variables] - ordered body parameters
 * @param {{ language?: string, headerMediaId?: string }} [options]
 * @returns {Promise<{ waMessageId: string, wmId: string }>}
 */
async function sendTemplate(to, templateName, variables = [], options = {}) {
  return callSamvaadik(async (client) => {
    const res = await client.post("/messages/template", {
      phone: to,
      template_name: templateName,
      language: options.language || "en_US",
      parameters: variables,
      ...(options.headerMediaId && { header_media_id: options.headerMediaId }),
    });
    return { waMessageId: res.data.wa_message_id, wmId: res.data.wm_id };
  });
}

/**
 * Send an interactive message with up to 3 quick-reply buttons.
 * Subject to the same 24-hour window as sendText.
 *
 * @param {string} to
 * @param {string} bodyText
 * @param {{id: string, label: string}[]} buttons - max 3
 * @returns {Promise<{ waMessageId: string, wmId: string }>}
 */
async function sendInteractive(to, bodyText, buttons) {
  if (!buttons || buttons.length === 0) {
    throw new Error("sendInteractive requires at least one button.");
  }
  if (buttons.length > 3) {
    throw new Error("WhatsApp allows a maximum of 3 quick-reply buttons.");
  }

  return callSamvaadik(async (client) => {
    const res = await client.post("/messages/interactive", {
      phone: to,
      body_text: bodyText,
      buttons: buttons.map((b) => ({ id: b.id, title: b.label })),
    });
    return { waMessageId: res.data.wa_message_id, wmId: res.data.wm_id };
  });
}

/**
 * Create a new WhatsApp message template and submit it to Meta for approval.
 *
 * WARNING: this route requires Samvaadik's `manage_templates` API-key
 * scope. As of this build, the ApiKeysPage create-key form only offers
 * Send Template / Send Message / Get Templates / Get Account as
 * selectable permissions — manage_templates isn't there to grant. If this
 * call fails with a 403, that's very likely why; it needs a fix on
 * Samvaadik's side (either exposing the scope in the UI, or granting it
 * some other way), not something fixable from this file.
 *
 * @param {string} name
 * @param {"MARKETING"|"UTILITY"|"AUTHENTICATION"} category
 * @param {string} bodyText - use {{1}}, {{2}}... for variables
 * @param {{
 *   language?: string,
 *   bodyExamples?: string[],
 *   headerFormat?: "TEXT"|"IMAGE"|"VIDEO"|"DOCUMENT",
 *   headerText?: string,
 *   headerHandle?: string,
 *   mediaId?: string,
 *   footerText?: string,
 *   buttons?: object[]
 * }} [options]
 */
async function createTemplate(name, category, bodyText, options = {}) {
  return callSamvaadik(async (client) => {
    const res = await client.post("/templates", {
      name,
      category,
      language: options.language || "en_US",
      body_text: bodyText,
      body_examples: options.bodyExamples || [],
      ...(options.headerFormat && { header_format: options.headerFormat }),
      ...(options.headerText && { header_text: options.headerText }),
      ...(options.headerHandle && { header_handle: options.headerHandle }),
      ...(options.mediaId && { media_id: options.mediaId }),
      ...(options.footerText && { footer_text: options.footerText }),
      ...(options.buttons && { buttons: options.buttons }),
    });
    return res.data.data; // { wt_id, name, category, language, status, header_format, media_id }
  });
}

/**
 * List approved templates on the connected WhatsApp account.
 * (Not in the original stub signature — added because the build doc's
 * Module 1 spec calls for it: "createTemplate, listTemplates".)
 *
 * @returns {Promise<object[]>}
 */
async function listTemplates() {
  return callSamvaadik(async (client) => {
    const res = await client.get("/templates");
    return res.data.data;
  });
}

/**
 * Download inbound media a customer/supplier sent.
 *
 * NOTE: Samvaadik's inbound webhook payload already includes a public,
 * directly-fetchable URL (Supabase storage) for any media — confirmed via
 * real captured payloads. No separate authenticated Samvaadik API call is
 * needed; this is just a plain HTTP GET on that URL.
 *
 * @param {string} mediaUrl - the media_url field from a parsed webhook event
 * @returns {Promise<Buffer>}
 */
async function downloadMedia(mediaUrl) {
  const axios = require("axios");
  const res = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    timeout: 20000,
  });
  return Buffer.from(res.data);
}

/**
 * Normalize a Samvaadik inbound webhook payload into a consistent shape.
 *
 * Confirmed real payload shape (captured via a test webhook, 27 Aug 2026):
 *   [{ event, account_id, from, message, message_type, media_url, timestamp }]
 * Always an array, even for a single event — handled defensively either way.
 * Only "message.received" has been observed; other event types (e.g. a
 * button/interactive reply) are unconfirmed and just logged as a warning
 * rather than assumed.
 *
 * @param {string|object} rawBody
 * @returns {{event: string, accountId: string, from: string, message: string, messageType: string, mediaUrl: string|null, timestamp: Date}[]}
 */
function parseWebhook(rawBody) {
  let parsed;
  try {
    parsed = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
  } catch (err) {
    throw new Error(`parseWebhook: invalid JSON payload: ${err.message}`);
  }

  const events = Array.isArray(parsed) ? parsed : [parsed];

  return events.map((evt) => {
    if (evt.event !== "message.received") {
      console.warn(
        `parseWebhook: unrecognized event type "${evt.event}" — only "message.received" is confirmed so far.`,
        evt,
      );
    }
    return {
      event: evt.event,
      accountId: evt.account_id,
      from: evt.from,
      message: evt.message,
      messageType: evt.message_type,
      mediaUrl: evt.media_url || null,
      timestamp: evt.timestamp ? new Date(evt.timestamp) : new Date(),
    };
  });
}

/**
 * Delete a WhatsApp template from Meta and Samvaadik.
 *
 * Confirmed against Samvaadik's real source (publicApiController.js,
 * Sept 2026) — this stub used to throw "blocked, no DELETE endpoint,"
 * which was true when it was written but is stale now; Samvaadik added
 * DELETE /v1/templates/:wt_id since. Samvaadik itself refuses (409,
 * code TEMPLATE_IN_USE) if any scheduled_messages/campaigns row still
 * references this template — callers should only reach this once the
 * template is genuinely done being used (Module 6's
 * templateDeletionSweep.js gates on sendStatus === "SENT" before calling
 * this), not rely on the 409 as the only guard.
 *
 * @param {string} wtId - Samvaadik's whatsapp_templates.wt_id
 * @returns {Promise<{wtId: string, name: string, metaDeleted: boolean, localRecordRetained: boolean}>}
 */
async function deleteTemplate(wtId) {
  return callSamvaadik(async (client) => {
    const res = await client.delete(`/templates/${wtId}`);
    return {
      wtId: res.data.data.wt_id,
      name: res.data.data.name,
      metaDeleted: res.data.data.meta_deleted,
      localRecordRetained: res.data.data.local_record_retained,
    };
  });
}

/**
 * Is the 24h customer-service window open for this contact?
 *
 * IMPORTANT — this is a FIRST-PASS check only, not the same rule
 * sendText actually enforces. Confirmed from Samvaadik's real source:
 * sendText's gate (check24hWindow in publicApiController.js) treats the
 * window as CLOSED if a template was sent to this contact more recently
 * than their last reply, even if the raw 24h hasn't elapsed
 * (TEMPLATE_ONLY_WAITING_FOR_USER) — getSessionWindow does not
 * replicate that rule, it only checks "was the last customer message
 * under 24h ago." A caller that trusts this alone to decide "is
 * freeform safe" can get session_open:true here and then have the real
 * sendText call reject with a 403. Treat this as a cheap first pass;
 * handle a 403 from sendText itself as the authoritative fallback
 * signal to use a template instead.
 *
 * @param {string} phone - digits only
 * @returns {Promise<{phone: string, sessionOpen: boolean, lastCustomerMessageAt: string|null, windowExpiresAt: string|null, secondsRemaining: number}>}
 */
async function getSessionWindow(phone) {
  return callSamvaadik(async (client) => {
    const res = await client.get("/messages/session-window", { params: { phone } });
    const d = res.data.data;
    return {
      phone: d.phone,
      sessionOpen: d.session_open,
      lastCustomerMessageAt: d.last_customer_message_at,
      windowExpiresAt: d.window_expires_at,
      secondsRemaining: d.seconds_remaining,
    };
  });
}

/**
 * Get a single template's current status by Samvaadik's own id — unlike
 * listTemplates (APPROVED only), this returns a template in ANY status,
 * which is the only way to poll a PENDING submission's approval state.
 * There is no webhook for this on Samvaadik's public API — polling is
 * the only option (confirmed from the real route file, no such webhook
 * route exists).
 *
 * @param {string} wtId
 * @returns {Promise<{wtId: string, name: string, status: string, ...}>}
 */
async function getTemplateStatus(wtId) {
  return callSamvaadik(async (client) => {
    const res = await client.get(`/templates/${wtId}`);
    const d = res.data.data;
    return { wtId: d.wt_id, name: d.name, status: d.status, category: d.category };
  });
}

/**
 * Schedule a WhatsApp template message for a future datetime — Samvaadik's
 * own cron picks it up and sends it, no send-time precision needed on our
 * side.
 *
 * NOTE ON `templateVariables`: this is a KEYED OBJECT ({"1": "Rahul", "2":
 * "Order #123"}), NOT the positional array sendTemplate/createTemplate use
 * — confirmed from scheduledMessageService.js. Easy to mix up with
 * createTemplate's bodyExamples, which IS positional.
 *
 * @param {object} input
 * @param {string} input.phone
 * @param {string} [input.contactName]
 * @param {string} input.wtId - must already be an APPROVED template (Samvaadik enforces this server-side)
 * @param {Record<string,string>} [input.templateVariables]
 * @param {string} [input.mediaId]
 * @param {string} input.scheduledAt - ISO 8601, must be in the future
 * @param {string} [input.timezone]
 * @param {string} [input.batchId] - groups scheduled messages, filterable via listScheduledMessages
 * @returns {Promise<object>} the full inserted scheduled_messages row, including sm_id
 */
async function scheduleTemplateMessage({
  phone,
  contactName,
  wtId,
  templateVariables = {},
  mediaId,
  scheduledAt,
  timezone,
  batchId,
}) {
  return callSamvaadik(async (client) => {
    const res = await client.post("/messages/schedule", {
      phone,
      contact_name: contactName,
      wt_id: wtId,
      template_variables: templateVariables,
      ...(mediaId && { media_id: mediaId }),
      scheduled_at: scheduledAt,
      ...(timezone && { timezone }),
      ...(batchId && { batch_id: batchId }),
    });
    return res.data.data; // includes sm_id
  });
}

/**
 * Get a single scheduled message's current status by Samvaadik's own id.
 *
 * @param {string} smId
 * @returns {Promise<object>} the scheduled_messages row (status, wa_message_id, sent_at, failed_at, error_message, ...)
 */
async function getScheduledMessageStatus(smId) {
  return callSamvaadik(async (client) => {
    const res = await client.get(`/messages/schedule/${smId}`);
    return res.data.data;
  });
}

/**
 * DEPRECATED — Shopify access goes directly through golfcare-backend now,
 * not through Samvaadik. Kept as a loud stub instead of removed so any
 * accidental call surfaces clearly instead of silently doing nothing.
 */
async function getProduct(shopifyProductId) {
  throw new Error(
    "getProduct is deprecated on the Samvaadik adapter — Shopify product data comes from golfcare-backend's own Prisma Product table (direct Shopify sync), not through Samvaadik.",
  );
}

/** @deprecated see getProduct */
async function updateInventory(variantId, status, leadTimeDays) {
  throw new Error(
    "updateInventory is deprecated on the Samvaadik adapter — inventory/availability is handled directly in golfcare-backend (Module 2, AvailabilityService), not through Samvaadik.",
  );
}

/** @deprecated see getProduct */
async function getOrderStatus(orderIdOrNumber) {
  throw new Error(
    "getOrderStatus is deprecated on the Samvaadik adapter — order data comes from golfcare-backend's own Prisma Order table (direct Shopify sync), not through Samvaadik.",
  );
}

module.exports = {
  sendText,
  sendTemplate,
  sendInteractive,
  downloadMedia,
  parseWebhook,
  createTemplate,
  listTemplates,
  deleteTemplate,
  getSessionWindow,
  getTemplateStatus,
  scheduleTemplateMessage,
  getScheduledMessageStatus,
  getProduct,
  updateInventory,
  getOrderStatus,
};
