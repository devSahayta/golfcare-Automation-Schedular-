// src/lib/docxTextExtractor.js
//
// Module 6.x — reads a supplier's bulk-import catalog in full when it's a
// Word document (.docx), for jobs/productImportDrain.js, the same way
// xlsxRowExtractor.js/pdfImageExtractor.js read their formats in full: by
// re-fetching and re-parsing the RAW file from sourceMediaUrl, never the
// already-truncated Message.body text (backend's documentExtractor.js caps
// extracted text at env.documentExtractMaxChars — 20,000 chars by default —
// at message-ingestion time).
//
// Mirrors the backend's own documentExtractor.js extractDocxText (can't
// require() across repos — same tradeoff already accepted for
// shopify.js/shopifyInventory.js/xlsxRowExtractor.js between these two
// repos): a plain regex pull of word/document.xml's own <w:t> text runs,
// not a full OOXML parser — this is a text-extraction step for an LLM to
// read, not a round-trippable document parser, so minor fidelity loss
// (run-level formatting) is an accepted tradeoff, same as the backend's.
//
// Unlike xlsxRowExtractor.js, a Word catalog has no guaranteed tabular
// structure (it could be a table, a bulleted list, or flowing paragraphs)
// — so this feeds the EXISTING plain-text segment path in
// extractBulkCatalogItems.js (the `documentText` mode, already hardened
// this round with the same truncation-retry safety net the page/row paths
// have), rather than inventing a new call shape the way rows needed.

const JSZip = require("jszip");

// Shares the exact OOXML-zip-signature check xlsxRowExtractor.js's isXlsx
// uses — .xlsx/.docx/.pptx all share the same zip magic bytes, so
// confirming this specific internal path is what tells them apart.
function isDocx(buffer) {
  if (
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    return false;
  }
  return buffer.includes("word/document.xml", 0, "latin1");
}

// Word wraps each run of text in <w:t>...</w:t> inside word/document.xml;
// a paragraph (<w:p>) can contain several runs (bold/italic/etc. each
// start a new run), so runs are joined with nothing between them and
// paragraphs are what get the newline, matching how the document actually
// reads.
const WORD_RUN_RE = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
const WORD_PARAGRAPH_RE = /<w:p[ >][\s\S]*?<\/w:p>/g;

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<string>} the WHOLE document's text, one line per
 *   paragraph — no character-count truncation anywhere in this path.
 */
async function extractDocxFullText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const doc = zip.file("word/document.xml");
  if (!doc) return "";
  const xml = await doc.async("string");

  const paragraphs = xml.match(WORD_PARAGRAPH_RE) || [];
  const lines = paragraphs.map((para) => {
    const runs = [...para.matchAll(WORD_RUN_RE)].map((m) => decodeXmlEntities(m[1]));
    return runs.join("");
  });
  return lines.join("\n");
}

module.exports = { isDocx, extractDocxFullText };
