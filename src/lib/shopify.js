// src/lib/shopify.js
//
// Self-contained Shopify client for golfcare-scheduler. This is a SEPARATE
// project from golfcare-backend, so this duplicates (rather than imports)
// the auth + import logic — can't require() across repos. If this drifts
// from golfcare-backend's version over time, that's an acceptable tradeoff
// for two independently-deployable services; keep the upsert field mapping
// in sync manually if the Prisma schema changes.

const axios = require("axios");
const { prisma } = require("./prisma");

const SHOPIFY_API_VERSION = "2024-10";
const PAGE_LIMIT = 250;

let cachedToken = null;
let cachedExpiresAt = 0;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

async function getValidAccessToken() {
  const isExpired = cachedExpiresAt - Date.now() < REFRESH_BUFFER_MS;
  if (cachedToken && !isExpired) return cachedToken;

  const { SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } =
    process.env;
  if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error(
      "Missing SHOPIFY_SHOP_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars in golfcare-scheduler.",
    );
  }

  const response = await axios.post(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    },
  );

  cachedToken = response.data.access_token;
  cachedExpiresAt = Date.now() + response.data.expires_in * 1000;
  return cachedToken;
}

function parseNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.split(",").find((p) => p.includes('rel="next"'));
  if (!match) return null;
  const urlMatch = match.match(/<([^>]+)>/);
  if (!urlMatch) return null;
  return new URL(urlMatch[1]).searchParams.get("page_info");
}

function computePriceRange(variants) {
  const prices = (variants || [])
    .map((v) => parseFloat(v.price))
    .filter((p) => !Number.isNaN(p));
  if (prices.length === 0) return { priceMin: 0, priceMax: 0 };
  return { priceMin: Math.min(...prices), priceMax: Math.max(...prices) };
}

async function upsertProduct(product) {
  const { priceMin, priceMax } = computePriceRange(product.variants);

  const savedProduct = await prisma.product.upsert({
    where: { shopifyProductId: String(product.id) },
    create: {
      shopifyProductId: String(product.id),
      handle: product.handle,
      title: product.title,
      vendor: product.vendor || null,
      productType: product.product_type || null,
      tags: product.tags
        ? product.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      descriptionHtml: product.body_html || null,
      imageUrls: (product.images || []).map((img) => img.src),
      priceMin,
      priceMax,
      status: product.status,
      syncedAt: new Date(),
    },
    update: {
      handle: product.handle,
      title: product.title,
      vendor: product.vendor || null,
      productType: product.product_type || null,
      tags: product.tags
        ? product.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      descriptionHtml: product.body_html || null,
      imageUrls: (product.images || []).map((img) => img.src),
      priceMin,
      priceMax,
      status: product.status,
      syncedAt: new Date(),
    },
  });

  for (const v of product.variants || []) {
    await prisma.variant.upsert({
      where: { shopifyVariantId: String(v.id) },
      create: {
        shopifyVariantId: String(v.id),
        productId: savedProduct.id,
        sku: v.sku || null,
        title: v.title || "Default",
        price: v.price ? parseFloat(v.price) : 0,
        compareAtPrice: v.compare_at_price
          ? parseFloat(v.compare_at_price)
          : null,
        optionValues: {
          option1: v.option1 || null,
          option2: v.option2 || null,
          option3: v.option3 || null,
        },
      },
      update: {
        sku: v.sku || null,
        title: v.title || "Default",
        price: v.price ? parseFloat(v.price) : 0,
        compareAtPrice: v.compare_at_price
          ? parseFloat(v.compare_at_price)
          : null,
        optionValues: {
          option1: v.option1 || null,
          option2: v.option2 || null,
          option3: v.option3 || null,
        },
      },
    });
  }
}

async function importAllProducts() {
  const accessToken = await getValidAccessToken();
  const client = axios.create({
    baseURL: `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    timeout: 25000,
  });

  let totalImported = 0;
  let pages = 0;
  let pageInfo = null;

  do {
    const params = { limit: PAGE_LIMIT };
    if (pageInfo) params.page_info = pageInfo;

    const res = await client.get("/products.json", { params });
    const products = res.data?.products || [];

    for (const product of products) {
      await upsertProduct(product);
    }

    totalImported += products.length;
    pages += 1;
    console.log(
      `[shopify] page ${pages}: imported ${products.length} (running total: ${totalImported})`,
    );
    pageInfo = parseNextPageInfo(res.headers?.link);

    if (pageInfo) await new Promise((r) => setTimeout(r, 600)); // stay under Shopify's rate limit
  } while (pageInfo);

  return { totalImported, pages };
}

// Mirrors golfcare-backend's services/shopifyProductCreate.js createDraftProduct
// — used by jobs/productImportDrain.js to create a real (unpublished)
// Shopify draft product per genuinely-new bulk-import item. Deliberately
// doesn't include the backend's publishProduct/publishToAllChannels —
// those only matter at human-approval time, which still happens through
// the existing backend productDraftController.js flow; this job only
// ever creates drafts, never approves/publishes one.
//
// Takes `variants` directly (one real Shopify variant per entry) rather
// than a single price/sku — a product can have several real variants
// (e.g. a belt in 4 colors), each with its own price/SKU, created in ONE
// product rather than as several separate single-variant products. A
// plain single-variant product is just variants with one entry and
// variantOptionName: null.
/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} [input.category]
 * @param {string} [input.specs]
 * @param {string} [input.brand]
 * @param {string} [input.imageUrl]
 * @param {string|null} [input.variantOptionName] - e.g. "Color"/"Size", null for a single-variant product
 * @param {{value: string|null, sku: string|null, mrp: number}[]} input.variants - at least one entry
 * @param {string[]} [input.tags] - e.g. ["APPARELS", "Belts", "Adidas"] — joined into Shopify's
 *        comma-separated tags string (a plain string field on Shopify's REST product, not an array)
 * @returns {Promise<{shopifyProductId: string, variantResults: {shopifyVariantId: string, mrp: number}[], handle: string, imageIncluded: boolean}>}
 */
async function createDraftProduct({
  title,
  category,
  specs,
  brand,
  imageUrl,
  variantOptionName,
  variants,
  tags,
}) {
  const accessToken = await getValidAccessToken();
  const client = axios.create({
    baseURL: `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });

  const shopifyVariants = variants.map((v) => {
    const sv = { price: String(v.mrp) };
    if (v.sku) sv.sku = v.sku;
    if (variantOptionName && v.value) sv.option1 = v.value;
    return sv;
  });

  const buildPayload = (withImage) => ({
    product: {
      title,
      body_html: specs || undefined,
      product_type: category || undefined,
      vendor: brand || undefined,
      status: "draft",
      ...(tags && tags.length ? { tags: tags.join(", ") } : {}),
      ...(variantOptionName ? { options: [{ name: variantOptionName }] } : {}),
      variants: shopifyVariants,
      ...(withImage && imageUrl ? { images: [{ src: imageUrl }] } : {}),
    },
  });

  let product;
  try {
    const res = await client.post("/products.json", buildPayload(true));
    product = res.data.product;
  } catch (err) {
    if (!imageUrl) throw err;
    // Same recoverable-failure reasoning as the backend version — a dead
    // image src shouldn't lose the whole draft.
    console.error(
      "[shopify] createDraftProduct with image failed, retrying without image:",
      err.response?.data || err.message,
    );
    const res = await client.post("/products.json", buildPayload(false));
    product = res.data.product;
  }

  const imageIncluded = Boolean(product.images && product.images.length > 0);

  return {
    shopifyProductId: String(product.id),
    // Shopify returns variants in the same order they were submitted, so
    // this lines up positionally with the `variants` input — used to
    // match each real created variant back to its own mrp for cost sync.
    variantResults: product.variants.map((v) => ({ shopifyVariantId: String(v.id), mrp: Number(v.price) })),
    handle: product.handle,
    imageIncluded,
  };
}

// Attaches a distinct image to one already-created variant — called in a
// loop by processItem() after createDraftProduct() returns, once per
// variant that ends up with a resolved image (document- or web-sourced).
// Must run AFTER creation: Shopify variant IDs don't exist before that,
// so there's no way to include this in the initial product-creation
// payload. POSTing an image with variant_ids creates the image AND sets
// that variant's image_id in the same call — no separate link step.
// Best-effort from the caller's side: this throws on failure, processItem()
// logs-and-continues, same posture as the cost-sync loop right below it.
/**
 * @param {string} shopifyProductId
 * @param {string} shopifyVariantId
 * @param {string} imageUrl
 * @returns {Promise<{shopifyImageId: string}>}
 */
async function addVariantImage(shopifyProductId, shopifyVariantId, imageUrl) {
  const accessToken = await getValidAccessToken();
  const client = axios.create({
    baseURL: `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });

  const res = await client.post(`/products/${shopifyProductId}/images.json`, {
    image: { src: imageUrl, variant_ids: [Number(shopifyVariantId)] },
  });
  return { shopifyImageId: String(res.data.image.id) };
}

module.exports = { importAllProducts, getValidAccessToken, createDraftProduct, addVariantImage };
