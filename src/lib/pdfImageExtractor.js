// src/lib/pdfImageExtractor.js
//
// Module 6.x — pulls each page's own text AND its real embedded product
// photos out of a supplier's catalog PDF, kept together per page so the
// extraction Claude call (extractBulkCatalogItems.js) can correlate "this
// page's text" with "this page's images" and correctly attribute a photo
// to the right product/variant.
//
// Scheduler-local, NOT shared with the backend's documentExtractor.js —
// that file is deliberately text-only and Vercel-tuned (DOMMatrix/Path2D
// stubs, require.resolve()'d worker path, all to dodge a documented
// pdf-parse/@vercel/nft crash). None of that applies here: this repo runs
// as a normal persistent Render Background Worker, not a serverless
// function, so there's no bundle-tracing problem and no reason to avoid a
// second small PDF library just because it needs its own binary resources.
//
// Images: pulled via pdf-lib, which parses the PDF's own object graph
// without rendering/decoding anything. Each page's /Resources -> /XObject
// dict is walked for entries with Subtype /Image and Filter /DCTDecode
// (plain JPEG) — those are raw, already-compressed JPEG bytes sitting in
// the PDF verbatim, so they're used as-is, no re-encode. Confirmed live
// against the real sample PDF (TRINITY LEAGUE2.pdf): every photo on its
// belt-in-4-colors page extracts byte-for-byte into a real, correctly
// rendering JPEG this way. v1 scope is deliberately JPEG-only — a
// FlateDecode/PNG-embedded image is skipped and counted, not decoded,
// since that needs a real zlib-inflate + raster reconstruction step this
// document family hasn't needed yet.
//
// Text: pulled via pdfjs-dist's getTextContent(), the same technique
// already proven in the backend's extractPdfText — just ported here
// directly (two repos, can't require() across them) since this job needs
// text split PER PAGE, not flattened into one string the way the
// backend's version deliberately does for its own (unrelated) use.

const { PDFDocument, PDFName, PDFRawStream } = require("pdf-lib");
const crypto = require("crypto");

function getWorkerSrc() {
  const { pathToFileURL } = require("url");
  return pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
}

let pdfjsLibPromise = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = getWorkerSrc();
      return lib;
    });
  }
  return pdfjsLibPromise;
}

async function extractPageTexts(buffer) {
  const pdfjsLib = await loadPdfjs();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  try {
    const doc = await loadingTask.promise;
    const texts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      texts.push(content.items.map((item) => item.str).join(" "));
    }
    return texts;
  } finally {
    await loadingTask.destroy();
  }
}

// XObjects are sometimes inherited from a parent Pages node rather than
// sitting directly on the leaf page's own /Resources — walk up until one
// is found, same way a PDF renderer would resolve it. Not hit by the real
// sample document (every page there has its own direct /Resources), but
// cheap to handle defensively rather than silently miss images on a PDF
// built differently.
function resolveResources(doc, pageNode) {
  let node = pageNode;
  for (let i = 0; i < 32 && node; i++) {
    const resources = typeof node.Resources === "function" ? node.Resources() : null;
    if (resources) return resources;
    const parentRef = node.get(PDFName.of("Parent"));
    node = parentRef ? doc.context.lookup(parentRef) : null;
  }
  return null;
}

// Walks one page's XObject dict once, returning both the usable JPEG
// images (as {bytes, contentHash}) and a count of non-JPEG images it had
// to skip (v1 scope — see file header). A single pass, since the dict
// only needs to be walked once per page.
function extractPageImages(doc, page) {
  const images = [];
  let skippedNonJpeg = 0;

  const resources = resolveResources(doc, page.node);
  const xobjDict = resources ? resources.lookup(PDFName.of("XObject")) : null;
  if (!xobjDict) return { images, skippedNonJpeg };

  for (const [, ref] of xobjDict.entries()) {
    const obj = doc.context.lookup(ref);
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.get(PDFName.of("Subtype"))?.asString?.() !== "/Image") continue;

    const filter = obj.dict.get(PDFName.of("Filter"));
    const filterStr = filter ? filter.toString() : "";
    if (!filterStr.includes("DCTDecode")) {
      skippedNonJpeg++;
      continue; // v1: JPEG only
    }

    const bytes = Buffer.from(obj.contents);
    const contentHash = crypto.createHash("sha1").update(bytes).digest("hex");
    images.push({ bytes, contentHash });
  }
  return { images, skippedNonJpeg };
}

/**
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{
 *   pages: {
 *     pageNumber: number,
 *     text: string,
 *     images: { index: number, contentHash: string, bytes: Buffer, mimeType: "image/jpeg" }[],
 *   }[],
 *   skippedNonJpegImageCount: number,
 * }>}
 */
async function extractPdfPagesWithImages(pdfBuffer) {
  const [texts, doc] = await Promise.all([
    extractPageTexts(pdfBuffer),
    PDFDocument.load(pdfBuffer, { ignoreEncryption: true }),
  ]);

  let skippedNonJpegImageCount = 0;
  const pages = doc.getPages().map((page, i) => {
    const { images: rawImages, skippedNonJpeg } = extractPageImages(doc, page);
    skippedNonJpegImageCount += skippedNonJpeg;

    const images = rawImages.map(({ bytes, contentHash }, index) => ({
      index,
      contentHash,
      bytes,
      mimeType: "image/jpeg",
    }));

    return { pageNumber: i + 1, text: texts[i] || "", images };
  });

  return { pages, skippedNonJpegImageCount };
}

module.exports = { extractPdfPagesWithImages };
