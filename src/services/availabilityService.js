// src/services/availabilityService.js
//
// Module 2 core, duplicated from golfcare-backend's src/services/
// availabilityService.js for the same cross-repo reason as lib/shopify.js
// (separate deployable, can't require() across repos — keep the mapping/
// policy in sync manually). The scheduler's own callers are the TTL decay
// sweep (jobs/availabilityDecay.js) and, later, the supplier check-in
// dispatch job (module 5).
//
// Ordering: the DB write (state + log + event) commits in one transaction
// first — that's Golf Care OS's own source of truth for availability. The
// Shopify write-back happens after, best-effort: a Shopify/network blip
// must never block or roll back the OS's own availability pipeline. A
// failed Shopify sync is recorded to AuditLog (for the dashboard to
// surface later) rather than retried indefinitely or allowed to fail the
// caller.
//
// Supplier fan-in policy (open decision, plan §4): a variant can have
// multiple SupplierProduct rows. Only the primary supplier's confirmation
// should call setAvailability() directly — others should just update
// their own SupplierProduct.lastConfirmedStatus for reliability tracking.
// Enforce that at the module 5 call site; this function is call-site
// agnostic.

const { prisma } = require("../lib/prisma");
const { writeAvailabilityToShopify } = require("../lib/shopifyInventory");

// Placeholder default — TTL per product category is still an open
// decision (plan §11.5). 168h = 7 days.
const DEFAULT_TTL_HOURS = Number(process.env.AVAILABILITY_TTL_HOURS || 168);

function invalidateProductCache(_variantId) {
  // TODO (module 3, lives in golfcare-backend): bust the Sales Agent's
  // product read-cache once it exists.
}

/**
 * @param {object} input
 * @param {string} input.variantId
 * @param {string} [input.productId] - derived from the variant if omitted
 * @param {"IN_STOCK"|"OUT_OF_STOCK"|"ON_ORDER"|"DISCONTINUED"|"UNKNOWN"} input.status
 * @param {"SUPPLIER_CONFIRMED"|"MANUAL_OWNER"|"AGENT_INFERRED"} input.source
 * @param {string} [input.changedBy] - staff user id, supplier id, or a system label like "system:ttl-sweep"
 * @param {number} [input.leadTimeDays]
 * @param {string} [input.note]
 * @param {number} [input.ttlHours] - overrides the default TTL for this write
 */
async function setAvailability({
  variantId,
  productId,
  status,
  source,
  changedBy,
  leadTimeDays = null,
  note = null,
  ttlHours,
}) {
  if (!variantId) throw new Error("setAvailability: variantId is required");
  if (!status) throw new Error("setAvailability: status is required");
  if (!source) throw new Error("setAvailability: source is required");

  const variant = await prisma.variant.findUnique({
    where: { id: variantId },
    select: { id: true, productId: true, shopifyVariantId: true },
  });
  if (!variant) {
    throw new Error(`setAvailability: variant ${variantId} not found`);
  }
  const resolvedProductId = productId || variant.productId;

  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + (ttlHours ?? DEFAULT_TTL_HOURS) * 60 * 60 * 1000,
  );

  const { availabilityState, previousStatus } = await prisma.$transaction(
    async (tx) => {
      const existing = await tx.availabilityState.findUnique({
        where: { variantId },
        select: { status: true },
      });

      const state = await tx.availabilityState.upsert({
        where: { variantId },
        create: {
          variantId,
          productId: resolvedProductId,
          status,
          source,
          leadTimeDays,
          confirmedBy: changedBy || null,
          confirmedAt: now,
          expiresAt,
          note,
        },
        update: {
          productId: resolvedProductId,
          status,
          source,
          leadTimeDays,
          confirmedBy: changedBy || null,
          confirmedAt: now,
          expiresAt,
          note,
        },
      });

      await tx.availabilityLog.create({
        data: {
          availabilityStateId: state.id,
          previousStatus: existing?.status ?? null,
          newStatus: status,
          changedBy: changedBy || "system",
        },
      });

      await tx.event.create({
        data: {
          type: "availability.changed",
          payload: {
            variantId,
            productId: resolvedProductId,
            previousStatus: existing?.status ?? null,
            newStatus: status,
            source,
            changedBy: changedBy || null,
          },
        },
      });

      return { availabilityState: state, previousStatus: existing?.status ?? null };
    },
  );

  invalidateProductCache(variantId);

  const shopifyResult = await writeAvailabilityToShopify(
    { shopifyVariantId: variant.shopifyVariantId },
    status,
  );

  if (!shopifyResult.ok) {
    console.error(
      `[availabilityService] Shopify write-back failed for variant ${variantId}:`,
      shopifyResult.error,
    );
    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "shopify_inventory_sync_failed",
        entityType: "Variant",
        entityId: variantId,
        beforeState: { status: previousStatus },
        afterState: { status, error: shopifyResult.error },
        source: "availability_service",
      },
    });
  }

  return { ...availabilityState, shopifySynced: shopifyResult.ok };
}

module.exports = { setAvailability };
