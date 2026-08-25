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

module.exports = { importAllProducts, getValidAccessToken };
