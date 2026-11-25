// src/lib/rehostImage.js
//
// Copies a product image found on the web into our own Supabase bucket and
// returns that copy's URL, or null if the image can't be fetched or isn't
// really an image.
//
// Why: Shopify downloads an image `src` itself, from its own servers, and
// several brand/retailer sites block that kind of request. Confirmed live
// (Nov 2026): footjoy.com answers 403 to anything that doesn't look like a
// browser (Shopify reported it as "file not found"), so 23 of 24 FootJoy
// drafts and every carlsgolfland.com draft came out with no image even
// though research had found a real one. The same URLs download fine with
// browser-like headers. Fetching here and handing Shopify our own copy
// fixes every such host at once, and also catches dead or non-image URLs
// before they're written onto a draft.

const axios = require("axios");
const { uploadDocumentImage } = require("./supabaseStorage");

const MAX_BYTES = 15 * 1024 * 1024; // Shopify accepts up to 20MB
const MIN_BYTES = 1024; // anything smaller is a placeholder/pixel, not a photo
// Tried in order. Tested live: footjoy.com and titleist.com refuse both
// Node's default User-Agent and a full Chrome one (their bot check spots a
// Chrome identity on a non-Chrome connection) but accept a plain
// "Mozilla/5.0"; the full Chrome one is kept as a fallback for sites that
// want it.
const HEADER_SETS = [
  { "User-Agent": "Mozilla/5.0", Accept: "image/*,*/*;q=0.8" },
  {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
  },
];

async function download(url) {
  let lastErr;
  for (const headers of HEADER_SETS) {
    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 20000,
        maxContentLength: MAX_BYTES,
        headers,
        validateStatus: (s) => s === 200,
      });
      return Buffer.from(res.data);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Checks the file's own first bytes rather than trusting Content-Type
// (one retailer here answered with a bare "image" type).
function sniffImageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (buf.toString("ascii", 0, 3) === "GIF") return { ext: "gif", mime: "image/gif" };
  return null;
}

/**
 * @param {string|null} url - an image URL found by research
 * @param {string} nameHint - used in the stored file name
 * @returns {Promise<string|null>} our own public URL, or null
 */
async function rehostImage(url, nameHint) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  // Already ours (a document photo) — nothing to copy.
  if (/\.supabase\.co\//i.test(url)) return url;
  try {
    const buf = await download(url);
    const type = sniffImageType(buf);
    if (!type || buf.length < MIN_BYTES) {
      console.warn(`[rehostImage] not a usable image (${buf.length} bytes): ${url}`);
      return null;
    }
    const upload = () => uploadDocumentImage(buf, `${nameHint}.${type.ext}`, type.mime);
    // One retry: a storage upload failed once with no error message during
    // the Nov 2026 image repair and succeeded straight after.
    return await upload().catch(upload);
  } catch (err) {
    console.warn(`[rehostImage] could not fetch ${url}: ${err.response?.status || err.code || err.message}`);
    return null;
  }
}

module.exports = { rehostImage, sniffImageType };
