// src/lib/xlsxRowExtractor.js
//
// Module 6.x — reads a supplier's bulk-import spreadsheet (XLSX) in full,
// for jobs/productImportDrain.js the same way pdfImageExtractor.js reads a
// PDF in full: by re-fetching and re-parsing the RAW file from
// sourceMediaUrl, never the already-truncated Message.body text (backend's
// documentExtractor.js caps extracted text at env.documentExtractMaxChars —
// 20,000 chars by default — at message-ingestion time; a real supplier
// sheet confirmed live at ~142,000 chars would lose 86% of its rows if this
// read it from there instead).
//
// Mirrors the backend's own documentExtractor.js extractXlsxText/cellToText
// (can't require() across repos — same tradeoff already accepted for
// shopify.js/shopifyInventory.js between these two repos) but returns
// structured { headerLine, rows } instead of one flattened string, so
// extractBulkCatalogItems.js can batch rows with the header repeated on
// every batch (a spreadsheet's header only appears once in the raw file,
// but every Claude call needs it to know what each column means — unlike a
// PDF, where a page-batch already has that context without being told).
//
// Scope: first worksheet only, same as the backend's version — a supplier
// sheet with real data on a second tab would need a human to notice and
// re-export, same limitation already accepted there.

const ExcelJS = require("exceljs");

// Shares the exact OOXML-zip-signature + docx/pptx-exclusion logic
// documentExtractor.js's detectFormat uses — .xlsx/.docx/.pptx all share
// the same zip magic bytes, so ruling out the other two (by their own
// fixed internal path) is what's left to confirm this is actually a
// spreadsheet, not just "some zip-based Office file." Needed so a .docx/
// .pptx bulk-import attachment doesn't get handed to ExcelJS, which would
// throw on it rather than read it as a (nonsensical) spreadsheet.
function isXlsx(buffer) {
  if (
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    return false;
  }
  if (buffer.includes("word/document.xml", 0, "latin1")) return false;
  if (buffer.includes("ppt/presentation.xml", 0, "latin1")) return false;
  return true;
}

function cellToText(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.richText) return value.richText.map((r) => r.text).join("");
    if (value.text != null) return String(value.text); // hyperlink cell
    if (value.result != null) return String(value.result); // formula cell
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return "";
  }
  return String(value);
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<{headerLine: string, rows: string[]}>}
 *   headerLine: the sheet's own first non-empty row, pipe-joined — repeated
 *   into every row-batch by extractBulkCatalogItems.js so each Claude call
 *   knows what each column means.
 *   rows: every data row after the header, pipe-joined, in original order,
 *   the WHOLE sheet — no character-count truncation anywhere in this path.
 */
async function extractXlsxRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { headerLine: "", rows: [] };

  let headerLine = "";
  const rows = [];
  let seenHeader = false;
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
    const line = cells.map(cellToText).join(" | ");
    if (!seenHeader) {
      headerLine = line;
      seenHeader = true;
      return;
    }
    rows.push(line);
  });

  return { headerLine, rows };
}

module.exports = { isXlsx, extractXlsxRows };
