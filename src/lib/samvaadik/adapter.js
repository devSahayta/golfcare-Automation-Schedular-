/**
 * Single interface to Samvaadik. Nothing else in the codebase should
 * call Samvaadik's HTTP API directly — always go through this file.
 *
 * TODO (Module 1): implement each method against the real Samvaadik API.
 * TODO (Module 1): confirm template deletion is actually exposed.
 */

/**
 * @param {string} to - E.164 phone number
 * @param {string} body
 * @returns {Promise<{waMessageId: string}>}
 */
async function sendText(to, body) {
  throw new Error("not implemented");
}

/**
 * @param {string} to
 * @param {string} templateName
 * @param {Record<string, string>} variables
 */
async function sendTemplate(to, templateName, variables) {
  throw new Error("not implemented");
}

/**
 * @param {string} to
 * @param {string} bodyText
 * @param {{id: string, label: string}[]} buttons
 */
async function sendInteractive(to, bodyText, buttons) {
  throw new Error("not implemented");
}

async function downloadMedia(mediaId) {
  throw new Error("not implemented");
}

function parseWebhook(rawBody) {
  throw new Error("not implemented");
}

/**
 * @param {string} name
 * @param {"MARKETING"|"UTILITY"} category
 * @param {string} bodyText
 */
async function createTemplate(name, category, bodyText) {
  throw new Error("not implemented");
}

async function deleteTemplate(templateId) {
  throw new Error("not implemented"); // TODO: confirm with Samvaadik this exists
}

async function getProduct(shopifyProductId) {
  throw new Error("not implemented");
}

async function updateInventory(variantId, status, leadTimeDays) {
  throw new Error("not implemented");
}

async function getOrderStatus(orderIdOrNumber) {
  throw new Error("not implemented");
}

module.exports = {
  sendText,
  sendTemplate,
  sendInteractive,
  downloadMedia,
  parseWebhook,
  createTemplate,
  deleteTemplate,
  getProduct,
  updateInventory,
  getOrderStatus,
};
