// src/lib/samvaadik/client.js
//
// One shared axios client for every Samvaadik API call. Centralizing this
// means the base URL and auth header only need to be right in one place —
// same lesson as golfcare-backend's shopify.js client.

const axios = require("axios");

function getClient() {
  const baseURL = process.env.SAMVAADIK_API_BASE_URL;
  const apiKey = process.env.SAMVAADIK_API_KEY;

  if (!baseURL) {
    throw new Error(
      "Missing SAMVAADIK_API_BASE_URL env var in golfcare-scheduler.",
    );
  }
  if (!apiKey) {
    throw new Error("Missing SAMVAADIK_API_KEY env var in golfcare-scheduler.");
  }

  return axios.create({
    baseURL: `${baseURL.replace(/\/$/, "")}/v1`,
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
}

/**
 * Wraps a Samvaadik API call so failures carry Samvaadik's actual error
 * body (not just a generic axios message) — matches the debugging pattern
 * used throughout the Shopify sync work, where seeing the real error body
 * saved a lot of guessing.
 */
async function callSamvaadik(fn) {
  try {
    return await fn(getClient());
  } catch (err) {
    const samvaadikError = err.response?.data;
    const status = err.response?.status;
    const detail = samvaadikError
      ? JSON.stringify(samvaadikError)
      : err.message;
    throw new Error(
      `Samvaadik API error${status ? ` (${status})` : ""}: ${detail}`,
    );
  }
}

module.exports = { callSamvaadik };
