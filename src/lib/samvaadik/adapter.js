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
 * BLOCKED — no matching Samvaadik endpoint.
 * Samvaadik's public API exposes GET/POST on /templates but no DELETE.
 * Flagged as an open question weeks ago — still unresolved. Needed before
 * any design that relies on self-deleting templates (e.g. a Lifecycle
 * Agent cleaning up expired campaign templates) can actually work.
 */
async function deleteTemplate(templateId) {
  throw new Error(
    "deleteTemplate is blocked: Samvaadik's public API has no DELETE /v1/templates/:id endpoint. " +
      "Needs to be added on Samvaadik's side before this can be implemented.",
  );
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
  getProduct,
  updateInventory,
  getOrderStatus,
};
