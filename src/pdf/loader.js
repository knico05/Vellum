/**
 * loader.js — PDF.js initialisation and PDF loading
 *
 * PDF.js parses the PDF binary in a Web Worker so the UI thread never
 * freezes while loading large documents. We point GlobalWorkerOptions.workerSrc
 * at the worker file before calling getDocument().
 *
 * In Electron's renderer, import.meta.url gives us a file:// URL for THIS
 * file, letting us construct a sibling-relative path to the worker without
 * needing __dirname (which is unavailable in ES modules + sandbox mode).
 *
 * Exports:
 *   loadPDF(arrayBuffer)        → Promise<PDFDocumentProxy>
 *   getPageDimensions(pdfDoc, pageIndex) → Promise<{width, height}>
 */

'use strict';

import * as pdfjsLib from '../../node_modules/pdfjs-dist/pdf.mjs';

// ---------------------------------------------------------------------------
// Worker configuration
// ---------------------------------------------------------------------------

// Construct the absolute file:// URL for the worker using import.meta.url
// as the base. This works in Electron's renderer without __dirname.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../../node_modules/pdfjs-dist/pdf.worker.mjs',
  import.meta.url
).href;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads a PDF from an ArrayBuffer and returns the PDF document object.
 * The document object is used to request individual pages for rendering.
 *
 * @param {ArrayBuffer} arrayBuffer — Raw PDF file bytes
 * @returns {Promise<import('pdfjs-dist').PDFDocumentProxy>}
 */
async function loadPDF(arrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  return loadingTask.promise;
}

/**
 * Returns the intrinsic dimensions of a PDF page in PDF user units (points).
 * 1 point = 1/72 inch. We treat 1 point as 1 canvas unit, so a standard
 * A4 page (595 × 842 pt) occupies 595 × 842 canvas units.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
 * @param {number} pageIndex — 0-based page index
 * @returns {Promise<{width: number, height: number}>}
 */
async function getPageDimensions(pdfDoc, pageIndex) {
  // PDF.js uses 1-based page numbers
  const page = await pdfDoc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1.0 });
  return { width: viewport.width, height: viewport.height };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { loadPDF, getPageDimensions };
