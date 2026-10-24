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
async function findExistingCatalogMatch({ title, sku, variantOptions }) {
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

  const scored = candidates
    .map((p) => {
      const candidateTokens = new Set(tokenize(p.title));
      const overlap = titleTokens.filter((t) => candidateTokens.has(t)).length;
      return { product: p, score: overlap / titleTokens.length };
    })
    .filter((s) => s.score >= 0.6)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[1].score >= scored[0].score - 0.15) return null;

  const product = scored[0].product;
  if (product.Variant.length === 0) return null;
  if (product.Variant.length === 1) return { product, variant: product.Variant[0] };

  const optionTokens = (variantOptions || []).flatMap((o) => tokenize(o.value));
  if (optionTokens.length === 0) return null;

  const variantScored = product.Variant.map((v) => {
    const vTokens = new Set(tokenize(v.title));
    const overlap = optionTokens.filter((t) => vTokens.has(t)).length;
    return { variant: v, score: overlap / optionTokens.length };
  }).sort((a, b) => b.score - a.score);

  if (variantScored[0].score < 0.5) return null;
  if (variantScored.length > 1 && variantScored[1].score >= variantScored[0].score) return null;

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

  const scored = drafts
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
