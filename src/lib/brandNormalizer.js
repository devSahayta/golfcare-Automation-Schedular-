// src/lib/brandNormalizer.js
//
// Maps whatever brand text a supplier's document uses onto the exact brand
// name this system stores (Supplier.brands / Product.vendor), BEFORE the
// bulk-import brand allowlist check runs.
//
// Why: that check is an exact (case-insensitive) match, so a correct
// product written with the supplier's own shorthand got held back as if it
// were a brand the supplier doesn't carry. Confirmed live on the Bhiwandi
// sheet: 235 FootJoy items stuck in NEEDS_BRAND_REVIEW because the sheet
// writes "FJ". Same class of problem: "BAGBOY" vs "BagBoy", "DISC" vs
// "Disc", "Callaway Golf" vs "Callaway", "Ram" vs "Ram Golf".
//
// Three steps, first hit wins:
//   1. Exact match against the known brands after compacting both sides
//      (lowercase, letters/digits only): "Bag Boy", "BAGBOY", "bag-boy" all
//      become "bagboy" → "BagBoy"; "G FORE" / "GFORE" → "G/FORE".
//   2. Same, ignoring a trailing "golf" on either side: "Callaway Golf" →
//      "Callaway", "Ram" → "Ram Golf", "Viper" → "Viper Golf".
//   3. The shorthand table below — abbreviations a supplier uses that no
//      spelling rule can recover. Only well-established golf-trade
//      abbreviations belong here: a wrong entry would label (and, if that
//      brand is allowed, draft) a product under the wrong brand, which is
//      worse than holding it for review.
// Anything else is returned unchanged (still trimmed) — so it is held for
// review exactly as before, never guessed.

// Keys are compacted (lowercase letters/digits only). Spelling variants
// ("Bag Boy", "GFORE", "Callaway Golf", "US Kids") don't need entries —
// steps 1-2 already handle them.
const SHORTHAND = {
  fj: "FootJoy",
  tm: "TaylorMade",
  tmag: "TaylorMade", // TaylorMade-adidas Golf
  taylormadeadidas: "TaylorMade",
  oj: "Oscar Jacobson",
  jn: "Jack Nicklaus",
  nicklaus: "Jack Nicklaus",
  scotty: "Scotty Cameron",
  cameron: "Scotty Cameron",
  g4: "G/FORE",
  sunmtn: "Sun Mountain",
};

function compact(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");
}

function withoutGolfSuffix(s) {
  return s.endsWith("golf") && s.length > 4 ? s.slice(0, -4) : s;
}

/**
 * @param {string|null|undefined} rawBrand - brand as written in the document
 * @param {string[]} knownBrands - canonical brand names (e.g. the
 *        supplier's own allowed list, or every brand in the system)
 * @returns {string|null} the canonical name when recognized, else the
 *          original text trimmed (null for empty input)
 */
function normalizeBrand(rawBrand, knownBrands = []) {
  if (rawBrand == null) return null;
  const trimmed = String(rawBrand).trim();
  if (!trimmed) return null;

  const key = compact(trimmed);
  const known = knownBrands.filter(Boolean);

  const exact = known.find((b) => compact(b) === key);
  if (exact) return exact;

  const keyNoGolf = withoutGolfSuffix(key);
  const noGolf = known.find((b) => withoutGolfSuffix(compact(b)) === keyNoGolf);
  if (noGolf) return noGolf;

  const alias = SHORTHAND[key] || SHORTHAND[keyNoGolf];
  if (alias) {
    // Prefer the exact spelling the caller's list uses, if it has it.
    return known.find((b) => compact(b) === compact(alias)) || alias;
  }

  return trimmed;
}

module.exports = { normalizeBrand, SHORTHAND };
