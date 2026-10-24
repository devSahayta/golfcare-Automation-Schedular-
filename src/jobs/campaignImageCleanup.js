// src/jobs/campaignImageCleanup.js
//
// Deletes Supabase Storage objects for campaign images that are 7+ days old
// to reclaim storage space. Two categories are cleaned:
//
//   1. Generated campaign images (BroadcastCampaign.headerImageUrl)
//      — stored at campaign-images/<filename>
//      — tracked in DB; marked with imageDeletedAt once removed
//
//   2. Temporary product reference images (uploaded during AI generation)
//      — stored at campaign-images/ref-images/<filename>
//      — NOT tracked in DB; identified by the file's lastModified timestamp
//        from the Supabase Storage listing
//
// Runs daily at 2 AM IST.
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in env.

const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");
const { prisma } = require("../lib/prisma");

const BUCKET = "campaign-images";
const REF_PREFIX = "ref-images/";
const MAX_AGE_DAYS = 7;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return createClient(url, key);
}

// Extract the storage path from a full Supabase public URL.
// e.g. https://<project>.supabase.co/storage/v1/object/public/campaign-images/foo.jpg
// → "foo.jpg"
function pathFromUrl(url) {
  if (!url) return null;
  try {
    const marker = `/object/public/${BUCKET}/`;
    const idx = url.indexOf(marker);
    if (idx === -1) return null;
    return decodeURIComponent(url.slice(idx + marker.length));
  } catch {
    return null;
  }
}

// ── Part 1: delete generated campaign images ─────────────────────────────────

async function cleanGeneratedImages(supabase) {
  const cutoff = new Date(Date.now() - MAX_AGE_MS);

  const campaigns = await prisma.broadcastCampaign.findMany({
    where: {
      headerImageUrl: { not: null },
      imageDeletedAt: null,
      createdAt: { lte: cutoff },
    },
    select: { id: true, headerImageUrl: true },
  });

  let deleted = 0;
  let failed = 0;

  for (const campaign of campaigns) {
    const storagePath = pathFromUrl(campaign.headerImageUrl);
    if (!storagePath) {
      await prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: { imageDeletedAt: new Date() },
      });
      continue;
    }

    const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
    if (error) {
      console.error(
        `[job] campaignImageCleanup: failed to delete ${storagePath} (campaign ${campaign.id}):`,
        error.message,
      );
      failed += 1;
    } else {
      await prisma.broadcastCampaign.update({
        where: { id: campaign.id },
        data: { imageDeletedAt: new Date() },
      });
      deleted += 1;
    }
  }

  return { deleted, failed };
}

// ── Part 2: delete temporary reference images ────────────────────────────────

async function cleanRefImages(supabase) {
  const cutoff = new Date(Date.now() - MAX_AGE_MS);

  const { data: files, error } = await supabase.storage
    .from(BUCKET)
    .list(REF_PREFIX, {
      limit: 1000,
      sortBy: { column: "created_at", order: "asc" },
    });

  if (error) {
    throw new Error(`Failed to list ref-images: ${error.message}`);
  }
  if (!files || files.length === 0) return { deleted: 0 };

  const stale = files.filter((f) => {
    const created = new Date(f.created_at || f.updated_at || 0);
    return created <= cutoff;
  });

  if (stale.length === 0) return { deleted: 0 };

  const paths = stale.map((f) => `${REF_PREFIX}${f.name}`);
  const { error: removeError } = await supabase.storage
    .from(BUCKET)
    .remove(paths);

  if (removeError) {
    throw new Error(`Failed to delete ref-images: ${removeError.message}`);
  }

  return { deleted: paths.length };
}

// ── Job registration ─────────────────────────────────────────────────────────

let isRunning = false;

async function runCleanup() {
  const supabase = getSupabase();

  const [genResult, refResult] = await Promise.allSettled([
    cleanGeneratedImages(supabase),
    cleanRefImages(supabase),
  ]);

  const gen =
    genResult.status === "fulfilled"
      ? genResult.value
      : (() => {
          console.error(
            "[job] campaignImageCleanup: generated-image cleanup failed:",
            genResult.reason?.message,
          );
          return { deleted: 0, failed: "?" };
        })();

  const ref =
    refResult.status === "fulfilled"
      ? refResult.value
      : (() => {
          console.error(
            "[job] campaignImageCleanup: ref-image cleanup failed:",
            refResult.reason?.message,
          );
          return { deleted: 0 };
        })();

  console.log(
    `[job] campaignImageCleanup complete — generated: deleted=${gen.deleted} failed=${gen.failed ?? 0} | ref-images: deleted=${ref.deleted}`,
  );
}

function registerCampaignImageCleanupJob() {
  // Run daily at 2:00 AM IST (UTC+5:30 → 20:30 UTC previous day)
  cron.schedule("30 20 * * *", async () => {
    if (isRunning) {
      console.log(
        "[job] campaignImageCleanup already running, skipping this tick.",
      );
      return;
    }
    isRunning = true;
    console.log("[job] campaignImageCleanup starting...");
    try {
      await runCleanup();
    } catch (err) {
      console.error("[job] campaignImageCleanup failed:", err.message);
    } finally {
      isRunning = false;
    }
  });
}

module.exports = { registerCampaignImageCleanupJob, runCleanup };
