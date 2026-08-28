// src/lib/shopifyInventory.js
//
// Self-contained Shopify inventory write-back for golfcare-scheduler.
// Mirrors golfcare-backend's src/services/shopifyInventory.js — this is a
// SEPARATE project (can't require() across repos, see lib/shopify.js's
// header for the same tradeoff note), so it duplicates rather than
// imports. Keep the two in sync manually if the mapping/policy changes.
//
// Best-effort write-back of AvailabilityState decisions into Shopify's
// real inventory numbers. The quantity mapping below is a PLACEHOLDER
// pending Tejas's decision on out-of-stock storefront behaviour (plan
// §11, open decision #1) — swap mapStatusToQuantity once that's decided.
//
// Golf Care OS doesn't persist Shopify's inventory_item_id, so it's
// resolved on demand from the variant and cached in-memory. The location
// id is resolved once the same way, unless SHOPIFY_LOCATION_ID is set.

const axios = require("axios");
const { getValidAccessToken } = require("./shopify");

const SHOPIFY_API_VERSION = "2024-10";

const inventoryItemIdCache = new Map(); // shopifyVariantId -> inventory_item_id
const trackedInventoryItemIds = new Set(); // inventory_item_ids already confirmed to have tracking enabled
let cachedLocationId = null;

async function shopifyClient() {
  const accessToken = await getValidAccessToken();
  return axios.create({
    baseURL: `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

async function getInventoryItemId(shopifyVariantId) {
  if (inventoryItemIdCache.has(shopifyVariantId)) {
    return inventoryItemIdCache.get(shopifyVariantId);
  }
  const client = await shopifyClient();
  const res = await client.get(`/variants/${shopifyVariantId}.json`);
  const inventoryItemId = res.data?.variant?.inventory_item_id;
  if (!inventoryItemId) {
    throw new Error(
      `Shopify variant ${shopifyVariantId} has no inventory_item_id`,
    );
  }
  inventoryItemIdCache.set(shopifyVariantId, inventoryItemId);
  return inventoryItemId;
}

async function getPrimaryLocationId() {
  if (process.env.SHOPIFY_LOCATION_ID) return process.env.SHOPIFY_LOCATION_ID;
  if (cachedLocationId) return cachedLocationId;

  const client = await shopifyClient();
  const res = await client.get("/locations.json");
  const location = (res.data?.locations || [])[0];
  if (!location) throw new Error("Shopify store has no locations");
  cachedLocationId = location.id;
  return cachedLocationId;
}

function mapStatusToQuantity(status) {
  const defaultQty = Number(process.env.SHOPIFY_DEFAULT_AVAILABLE_QTY || 99);
  switch (status) {
    case "IN_STOCK":
    case "ON_ORDER":
      return defaultQty;
    case "OUT_OF_STOCK":
    case "DISCONTINUED":
    case "UNKNOWN":
    default:
      return 0;
  }
}

// Dropship products are commonly created in Shopify with "Track quantity"
// off (nothing is held locally, so there was never a number to track) —
// inventory_levels/set errors with "does not have inventory tracking
// enabled" against those. Turn tracking on the first time Golf Care OS
// writes to a variant, then cache that it's done so this doesn't fire on
// every write. This is idempotent on Shopify's side (setting tracked:true
// when it's already true is a no-op), so no need to check first.
async function ensureInventoryTracked(inventoryItemId) {
  if (trackedInventoryItemIds.has(inventoryItemId)) return;
  const client = await shopifyClient();
  await client.put(`/inventory_items/${inventoryItemId}.json`, {
    inventory_item: { id: inventoryItemId, tracked: true },
  });
  trackedInventoryItemIds.add(inventoryItemId);
}

async function setInventoryLevel(inventoryItemId, locationId, available) {
  const client = await shopifyClient();
  await client.post("/inventory_levels/set.json", {
    location_id: locationId,
    inventory_item_id: inventoryItemId,
    available,
  });
}

/**
 * Best-effort — never throws. AvailabilityService's own DB commit must not
 * be blocked or rolled back by a Shopify/network blip.
 *
 * @param {{shopifyVariantId: string}} variant
 * @param {string} status - an AvailStatus value
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
async function writeAvailabilityToShopify(
  { shopifyVariantId },
  status,
  { attempts = 2, retryDelayMs = 500 } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const [inventoryItemId, locationId] = await Promise.all([
        getInventoryItemId(shopifyVariantId),
        getPrimaryLocationId(),
      ]);
      await ensureInventoryTracked(inventoryItemId);
      await setInventoryLevel(
        inventoryItemId,
        locationId,
        mapStatusToQuantity(status),
      );
      return { ok: true };
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
  return {
    ok: false,
    error:
      lastError?.response?.data || lastError?.message || String(lastError),
  };
}

module.exports = { writeAvailabilityToShopify };
