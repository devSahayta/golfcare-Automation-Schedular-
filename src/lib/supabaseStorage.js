// src/lib/supabaseStorage.js
//
// Hosts product photos pulled straight out of a supplier's catalog PDF
// (pdfImageExtractor.js) somewhere with a real public HTTPS URL — Shopify's
// product/variant-image endpoints need a fetchable src, and the extracted
// bytes otherwise only exist in memory for the lifetime of one scheduler
// tick. Same role for this pipeline that golfcare-backend's
// services/supabaseStorageService.js plays for Module 6's AI-generated
// campaign images — deliberately mirrors that file's shape (lazy public
// bucket creation, same createClient/upload/getPublicUrl pattern) rather
// than inventing a new one, but lives here independently since the two
// repos can't require() each other.
//
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are already sitting in this
// repo's .env (present because the Postgres DB itself is Supabase-hosted)
// but were unused by any code here until now — same reuse story as the
// backend's own version. A separate bucket (PRODUCT_IMPORT_IMAGE_BUCKET,
// default "product-import-images") keeps this asset class apart from
// anything else that bucket-per-purpose convention might host later.
//
// Usage:
//   const { uploadDocumentImage } = require('./supabaseStorage');
//   const url = await uploadDocumentImage(jpegBuffer, 'belt-navy.jpg');

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.PRODUCT_IMPORT_IMAGE_BUCKET || "product-import-images";

let client = null;
function getClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env to upload " +
        "extracted document images (same Supabase project this repo's DATABASE_URL " +
        "already points at — just the URL and service role key from Project Settings → API).",
    );
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}

// Created lazily, once per process, the first time an upload is attempted —
// not at module load, so a missing bucket never breaks job startup, only
// the specific extraction run that needs it.
let bucketEnsured = false;
async function ensureBucket() {
  if (bucketEnsured) return;
  const supabase = getClient();

  const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) {
    // Some service-role configurations restrict listBuckets even though
    // upload/getPublicUrl work fine. Don't hard-fail here — assume the
    // bucket already exists; the next line finds out for real.
    console.warn(
      `[supabaseStorage] Couldn't list buckets (${listErr.message}) — assuming "${BUCKET}" already exists and is public.`,
    );
    bucketEnsured = true;
    return;
  }

  const exists = (buckets || []).some((b) => b.name === BUCKET);
  if (!exists) {
    const { error: createErr } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (createErr && !/already exists/i.test(createErr.message || "")) {
      throw new Error(`Failed to create Supabase Storage bucket "${BUCKET}": ${createErr.message}`);
    }
    console.log(`[supabaseStorage] Created public bucket "${BUCKET}"`);
  }
  bucketEnsured = true;
}

/**
 * uploadDocumentImage
 *
 * Uploads a JPEG buffer extracted from a supplier PDF to Supabase Storage
 * and returns its public URL.
 *
 * @param {Buffer} buffer    - JPEG image bytes
 * @param {string} fileName  - used to build a unique object path (sanitized)
 * @returns {Promise<string>} public HTTPS URL
 */
async function uploadDocumentImage(buffer, fileName) {
  await ensureBucket();
  const supabase = getClient();

  const safeName = (fileName || "product-image.jpg").replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${Date.now()}-${safeName}`;

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: "image/jpeg", upsert: false });

  if (uploadErr) {
    throw new Error(`Supabase Storage upload failed: ${uploadErr.message}`);
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) {
    throw new Error("Supabase Storage upload succeeded but no public URL was returned.");
  }

  console.log(`[supabaseStorage] Uploaded ${path} -> ${data.publicUrl}`);
  return data.publicUrl;
}

module.exports = { uploadDocumentImage };
