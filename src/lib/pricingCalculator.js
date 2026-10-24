// src/lib/pricingCalculator.js
//
// Mirrors golfcare-backend's services/pricingCalculator.js — pure
// arithmetic, duplicated rather than imported (separate repo). Formula,
// as given: take the supplier's margin off MRP, then add GST on top.
//
// costPrice = MRP * (1 - marginPercent/100) * (1 + gstPercent/100)

function computeCostPrice({ mrp, marginPercent, gstPercent }) {
  const afterMargin = mrp * (1 - marginPercent / 100);
  const withGst = afterMargin * (1 + gstPercent / 100);
  return Math.round(withGst * 100) / 100; // round to paise
}

module.exports = { computeCostPrice };
