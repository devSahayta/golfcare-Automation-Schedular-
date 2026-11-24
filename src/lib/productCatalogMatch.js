// src/lib/productCatalogMatch.js
//
// Mirrors golfcare-backend's services/supplierAgent/supplierAgentTools.js
// findExistingCatalogMatch (plus its tokenize/STOPWORDS helpers) —
// duplicated rather than imported (separate repo, see lib/shopify.js's
// header for the same tradeoff note). Used by jobs/productImportDrain.js
// to check a bulk-import item against Golf Care's whole catalog before
// creating a new Shopify product — the same "this might not be new at
// all" check the backend's one-by-one create_product_draft tool does.
// Keep in sync manually if the matching logic changes.
//
// Errs toward "no match" on real ambiguity — a false "already exists"
// (skips creating a real new listing) and a false "genuinely new"
// (creates a duplicate Shopify product) are both bad, but a duplicate is
// far more annoying to clean up than asking again, so this only returns a
// match when it's confident.

const { prisma } = require("./prisma");

const STOPWORDS = new Set([
  "the", "and", "for", "with", "size", "have", "any", "golf", "set", "of",
]);

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} [input.sku]
 * @param {{name: string, value: string}[]} [input.variantOptions]
 * @returns {Promise<{product: object, variant: object} | null>}
 */
// Both sides have a SKU and they differ → a different item, whatever the
// title says. Confirmed live: Adidas KBG277 (Ultimate365 Tapered Golf
// Pants, Wonder Sage) title-matched the store's existing single-variant
// "Ultimate365 Tapered Golf Pants" (Hemp, IU2835) — a bulk import would
// have marked HEMP in stock and linked the supplier to it, and the Wonder
// Sage pants would never have been added. A different colour/article is
// not "already in the store". Missing SKU on either side → no opinion.
//
// Golf Care's own store SKUs ("WC-16323" — 4,878 of ~4,900 live variants)
// are internal codes, never a maker's article number, so a supplier's code
// can't be compared with them: treated as "no SKU", or nearly every
// legitimate title match would flip to "new" (checked against past bulk
// imports: 19 of 20 linked items would have).
const INTERNAL_STORE_SKU_RE = /^WC-\d+$/i;
function skuConflicts(sku, otherSku) {
  if (!sku || !otherSku) return false;
  if (INTERNAL_STORE_SKU_RE.test(String(otherSku).trim())) return false;
  return String(sku).trim().toLowerCase() !== String(otherSku).trim().toLowerCase();
}

// Model-word rule. Title overlap alone (>= 60% of the supplier's words)
// let look-alikes through, because the shared words were generic:
// "Titleist AVX Dozen" matched "Titleist Pro V1 Golf Balls (Dozen)",
// "GS Solid Lisle Black Shirt" matched "Jungle Leaves Lisle Golf Polo -
// Black", "Pro SL Carbon BOA" matched "Pro SLX Boa XW Spikeless Golf
// Shoes". What tells products apart is the model word (avx, solid, carbon),
// so every MODEL WORD in the incoming title must also be in the store
// title. A model word is one that appears in only a few store titles
// (1..MODEL_WORD_MAX_TITLES) — measured from the live catalog, not a
// hand-kept list — and isn't:
//   - a brand: store titles mostly leave the brand out ("adidas" is in 7
//     of 1,847 titles), so brand words come from Product.vendor instead;
//   - a packaging/marketing word that's rare in titles but says nothing
//     about which product it is (GENERIC_WORDS);
//   - unknown to the store (0 titles): likely supplier shorthand ("GS"),
//     which no store title could contain anyway.
const MODEL_WORD_MAX_TITLES = 20;
const GENERIC_WORDS = new Set([
  "dozen", "pack", "pcs", "pc", "piece", "pieces", "box", "new", "edition",
  "mens", "womens", "ladies", "unisex", "junior", "kids", "youth",
  "2022", "2023", "2024", "2025", "2026", "2027",
]);
const STATS_TTL_MS = 10 * 60 * 1000;
let titleStatsCache = null;

async function getTitleStats() {
  if (titleStatsCache && Date.now() - titleStatsCache.at < STATS_TTL_MS) return titleStatsCache;
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { title: true, vendor: true },
  });
  const titleCount = new Map();
  const brandWords = new Set();
  for (const p of products) {
    for (const t of new Set(tokenize(p.title))) titleCount.set(t, (titleCount.get(t) || 0) + 1);
    for (const t of tokenize(p.vendor)) brandWords.add(t);
  }
  titleStatsCache = { at: Date.now(), titleCount, brandWords };
  return titleStatsCache;
}

function modelWords(titleTokens, stats, extraBrandWords) {
  return titleTokens.filter((t) => {
    const n = stats.titleCount.get(t) || 0;
    return (
      n >= 1 &&
      n <= MODEL_WORD_MAX_TITLES &&
      !GENERIC_WORDS.has(t) &&
      !stats.brandWords.has(t) &&
      !extraBrandWords.has(t)
    );
  });
}

async function findExistingCatalogMatch({ title, sku, variantOptions, brand }) {
  if (sku) {
    const bySku = await prisma.variant.findFirst({
      where: { sku: { equals: sku, mode: "insensitive" }, Product: { status: "active" } },
      include: { Product: true },
    });
    if (bySku) return { product: bySku.Product, variant: bySku };
  }

  const titleTokens = tokenize(title);
  if (titleTokens.length === 0) return null;

  const candidates = await prisma.product.findMany({
    where: {
      status: "active",
      OR: titleTokens.slice(0, 6).map((w) => ({ title: { contains: w, mode: "insensitive" } })),
    },
    include: { Variant: true },
    take: 15,
  });
  if (candidates.length === 0) return null;

  const stats = await getTitleStats();
  const required = modelWords(titleTokens, stats, new Set(tokenize(brand)));
  const scored = candidates
    .map((p) => {
      const candidateTokens = new Set(tokenize(p.title));
      const overlap = titleTokens.filter((t) => candidateTokens.has(t)).length;
      return { product: p, score: overlap / titleTokens.length, candidateTokens };
    })
    .filter((s) => s.score >= 0.6)
    .filter((s) => required.every((t) => s.candidateTokens.has(t)))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[1].score >= scored[0].score - 0.15) return null;

  const product = scored[0].product;
  if (product.Variant.length === 0) return null;
  if (product.Variant.length === 1) {
    if (skuConflicts(sku, product.Variant[0].sku)) return null;
    return { product, variant: product.Variant[0] };
  }

  const optionTokens = (variantOptions || []).flatMap((o) => tokenize(o.value));
  if (optionTokens.length === 0) return null;

  const variantScored = product.Variant.map((v) => {
    const vTokens = new Set(tokenize(v.title));
    const overlap = optionTokens.filter((t) => vTokens.has(t)).length;
    return { variant: v, score: overlap / optionTokens.length };
  }).sort((a, b) => b.score - a.score);

  if (variantScored[0].score < 0.5) return null;
  if (variantScored.length > 1 && variantScored[1].score >= variantScored[0].score) return null;

  if (skuConflicts(sku, variantScored[0].variant.sku)) return null;
  return { product, variant: variantScored[0].variant };
}

// Catches the gap findExistingCatalogMatch can't: a product that's been
// SUBMITTED (one-by-one chat flow or an earlier bulk batch) but not yet
// approved/published, so it has no Product/Variant row to match against
// yet, even though a real ProductDraft already exists for it. Confirmed
// live: the same item got drafted twice, a day apart, once via each flow.
// Scoped across ALL suppliers (not just the one submitting now) — "already
// present" shouldn't depend on who sent it first. PENDING and APPROVED
// both count as "already present"; REJECTED/EXPIRED are excluded on
// purpose so a resubmission after either of those can go through fresh.
// Same tokenize/scoring thresholds as findExistingCatalogMatch above, for
// consistency rather than a third matching style — fetches all
// PENDING/APPROVED rows (now indexed on approvalStatus) and scores in JS,
// since rawPayload is a Json column with no efficient DB-side text search.
/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} [input.sku]
 * @returns {Promise<{draftId: string} | null>}
 */
async function findPendingDraftMatch({ title, sku }) {
  const drafts = await prisma.productDraft.findMany({
    where: { approvalStatus: { in: ["PENDING", "APPROVED"] } },
    select: { id: true, rawPayload: true },
  });
  if (drafts.length === 0) return null;

  if (sku) {
    const skuLower = sku.toLowerCase();
    const bySku = drafts.find((d) => {
      const p = d.rawPayload || {};
      if ((p.sku || "").toLowerCase() === skuLower) return true;
      return (Array.isArray(p.variants) ? p.variants : []).some(
        (v) => (v.sku || "").toLowerCase() === skuLower,
      );
    });
    if (bySku) return { draftId: bySku.id };
  }

  const titleTokens = tokenize(title);
  if (titleTokens.length === 0) return null;

  // Same different-SKU rule as findExistingCatalogMatch: a pending draft
  // for another colour/article of the same title isn't this item.
  const draftSkus = (p) =>
    [p.sku, ...(Array.isArray(p.variants) ? p.variants.map((v) => v.sku) : [])].filter(Boolean);
  const scored = drafts
    .filter((d) => {
      const skus = draftSkus(d.rawPayload || {});
      return !sku || skus.length === 0 || !skus.every((x) => skuConflicts(sku, x));
    })
    .map((d) => {
      const draftTitle = d.rawPayload?.title || "";
      const draftTokens = new Set(tokenize(draftTitle));
      const overlap = titleTokens.filter((t) => draftTokens.has(t)).length;
      return { draft: d, score: overlap / titleTokens.length };
    })
    .filter((s) => s.score >= 0.6)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  // Deliberately NO dominance-gap tie-break here, unlike findExistingCatalogMatch
  // above — that check exists to avoid confidently picking between two
  // DIFFERENT real products that happen to score similarly, where picking
  // wrong means silently updating the wrong product's stock. Here, a tie
  // just means several pending drafts already match this title (confirmed
  // real case: the same item got drafted twice) — any one of them is a
  // valid "this already exists" signal, so a tie is if anything stronger
  // evidence to block, never a reason to give up and create yet another.

  return { draftId: scored[0].draft.id };
}

module.exports = { findExistingCatalogMatch, findPendingDraftMatch };
