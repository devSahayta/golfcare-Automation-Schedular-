// src/jobs/productImportImageCleanup.js
//
// Deletes temporary product reference images from the "product-import-images"
// Supabase Storage bucket after 2 days to reclaim space.
//
// These images are uploaded by the supplier agent during bulk product import
// (PDF page images, extracted product photos) and are not tracked in the DB —
// identified purely by the file's created_at timestamp from the storage listing.
//
// Runs daily at 2:30 AM IST (21:00 UTC).
// Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in env.

const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");

const BUCKET = "product-import-images";
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

async function runCleanup() {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - MAX_AGE_MS);

  // List all files in the bucket root (and subfolders if any)
  const { data: files, error } = await supabase.storage
    .from(BUCKET)
    .list("", { limit: 1000, sortBy: { column: "created_at", order: "asc" } });

  if (error) {
    throw new Error(
      `[job] productImportImageCleanup: failed to list bucket: ${error.message}`,
    );
  }
  if (!files || files.length === 0) {
    console.log("[job] productImportImageCleanup complete — no files found");
    return;
  }

  // Filter to files older than cutoff
  const stale = files.filter((f) => {
    const created = new Date(f.created_at || f.updated_at || 0);
    return created <= cutoff;
  });

  if (stale.length === 0) {
    console.log("[job] productImportImageCleanup complete — no stale files");
    return;
  }

  const paths = stale.map((f) => f.name);
  const { error: removeError } = await supabase.storage
    .from(BUCKET)
    .remove(paths);

  if (removeError) {
    throw new Error(
      `[job] productImportImageCleanup: failed to delete files: ${removeError.message}`,
    );
  }

  console.log(
    `[job] productImportImageCleanup complete — deleted=${paths.length}`,
  );
}

let isRunning = false;

function registerProductImportImageCleanupJob() {
  // Run daily at 2:30 AM IST (UTC+5:30 → 21:00 UTC previous day)
  cron.schedule("0 21 * * *", async () => {
    if (isRunning) {
      console.log("[job] productImportImageCleanup already running, skipping.");
      return;
    }
    isRunning = true;
    console.log("[job] productImportImageCleanup starting...");
    try {
      await runCleanup();
    } catch (err) {
      console.error("[job] productImportImageCleanup failed:", err.message);
    } finally {
      isRunning = false;
    }
  });
}

module.exports = { registerProductImportImageCleanupJob, runCleanup };
