// src/lib/shopifyTaxonomy.js
//
// This store's REAL product_type -> broad-tag vocabulary, built by
// directly querying the already-synced Product table (productType/tags,
// pulled from real Shopify data via importAllProducts) — not invented.
// Confirmed real quirks worth encoding rather than letting a hand-rolled
// keyword mapping get wrong: a polo shirt's product_type here is
// "T-Shirts", not "Polos"; pants are "Trousers", not "Pants".
//
// Used two ways:
//   - fed into extractBulkCatalogItems.js's prompt so the extraction call
//     classifies each item against this store's actual taxonomy instead
//     of guessing a type that doesn't exist here;
//   - broadTagFor() turns the chosen productType into the matching
//     UPPERCASE broad-category tag this store's existing products already
//     carry (e.g. "Belts" -> "APPARELS"), which is what most of this
//     store's tag-based smart collections actually key on.
//
// Deliberately a curated subset, not the full ~80 distinct real values —
// dropped clear one-off anomalies in the source data (e.g. a handful of
// products whose only uppercase tag happened to be a vendor name, an
// artifact of inconsistent past tagging, not a real convention) rather
// than replicate noise into new products going forward.
const VOCABULARY = [
  ["T-Shirts", "APPARELS"],
  ["Shoes", "SHOES"],
  ["Putters", "CLUBS"],
  ["Women's", "APPARELS"],
  ["Irons", "CLUBS"],
  ["Balls", "BALLS"],
  ["Headwear", "APPARELS"],
  ["Gloves", "GLOVES"],
  ["Grips", "GRIPS"],
  ["Hybrids", "CLUBS"],
  ["Fairway Woods", "CLUBS"],
  ["Stand Bags", "BAGS"],
  ["Drivers", "CLUBS"],
  ["Package Sets", "CLUBS"],
  ["Trousers", "APPARELS"],
  ["Headcovers", "DAILY NEEDS"],
  ["Wedges", "CLUBS"],
  ["Winter Wear", "APPARELS"],
  ["Belts", "APPARELS"],
  ["Shorts", "APPARELS"],
  ["Tees", "DAILY NEEDS"],
  ["Hat Clips & Markers", "DAILY NEEDS"],
  ["Putting Practice", "TRAINING"],
  ["Cart Bags", "BAGS"],
  ["Boston Bags", "BAGS"],
  ["Duffle Bags", "BAGS"],
  ["Towels", "DAILY NEEDS"],
  ["Umbrellas", "DAILY NEEDS"],
  ["Eyewear", "APPARELS"],
  ["Golf Gifts", "DAILY NEEDS"],
  ["Rangefinders", "DAILY NEEDS"],
  ["Chippers", "CLUBS"],
  ["Personalized Bags", "BAGS"],
  ["On-Course Accessories", "DAILY NEEDS"],
  ["Utility Irons", "CLUBS"],
  ["Cleaning & Repair Tools", "DAILY NEEDS"],
  ["Arm Sleeves", "APPARELS"],
  ["Socks", "APPARELS"],
  ["Staff Bags", "BAGS"],
  ["Ball Pouches & Holders", "DAILY NEEDS"],
  ["Swing Correction", "TRAINING"],
  ["Organiser Bags", "BAGS"],
  ["Travel Bags", "BAGS"],
  ["Practice Balls", "TRAINING"],
  ["Back Pack", "BAGS"],
  ["Rain Wear", "APPARELS"],
  ["Holiday Bags", "BAGS"],
  ["Travel Cover Bags", "BAGS"],
  ["Shoe Bags", "BAGS"],
  ["Rain Covers", "BAGS"],
  ["Vests", "APPARELS"],
];

function broadTagFor(productType) {
  if (!productType) return null;
  const match = VOCABULARY.find(([type]) => type.toLowerCase() === productType.toLowerCase());
  return match ? match[1] : null;
}

module.exports = { VOCABULARY, broadTagFor };
