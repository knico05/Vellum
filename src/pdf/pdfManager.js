/**
 * pdfManager.js — Orchestrates loading, layout, and rendering of PDF pages
 *
 * This is the single module responsible for:
 *   1. Loading a PDF via PDF.js (loader.js)
 *   2. Creating a PDFPage instance for every page (page.js)
 *   3. Laying them out vertically on the canvas
 *   4. Centring the viewport on page 1
 *   5. Rendering pages that are near the viewport (lazy)
 *   6. Tearing down when a new PDF is opened
 *
 * It registers a draw callback with the renderer so updatePosition() is
 * called each frame (keeping page canvases in sync with pan/zoom).
 * It also listens to 'viewport-changed' to trigger lazy render checks.
 *
 * Exports: openPDF(filePath), getCurrentPdfPath(), getPageCount()
 */

'use strict';

import { loadPDF, getPageDimensions } from './loader.js';
import { PDFPage, layoutPages }       from './page.js';
import { centreOn, state as viewport } from '../canvas/viewport.js';
import { register, requestRender }    from '../canvas/renderer.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The currently loaded PDFDocumentProxy, or null */
let pdfDoc = null;

/** Absolute file path of the currently loaded PDF */
let currentPath = null;

/** Array of PDFPage instances for the current document */
let pages = [];

/** The #canvas-container element */
let container = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Must be called once after the DOM is ready.
 * Registers the per-frame draw callback and the viewport-changed listener.
 */
function init() {
  container = document.getElementById('canvas-container');

  // Each frame: reposition all mounted page canvases
  register(() => {
    for (const page of pages) page.updatePosition();
  });

  // When the viewport changes: check which pages need lazy-rendering
  container.addEventListener('viewport-changed', () => {
    triggerLazyRender();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Opens a PDF from a file path, replacing any currently loaded document.
 *
 * Flow:
 *   1. Read the file bytes via IPC bridge
 *   2. Pass to PDF.js to parse
 *   3. Get dimensions for all pages
 *   4. Create PDFPage instances, mount them, lay them out
 *   5. Centre viewport on page 1
 *   6. Trigger initial lazy render
 *
 * @param {string} filePath — Absolute path to the PDF file
 * @returns {Promise<void>}
 */
async function openPDF(filePath) {
  tearDown();
  currentPath = filePath;

  const bytes = await window.api.readFile(filePath);

  // Pass Uint8Array directly — avoids byteOffset issues with .buffer
  pdfDoc = await loadPDF(bytes);

  const numPages = pdfDoc.numPages;

  // Fetch dimensions for all pages (needed to lay them out before rendering)
  const dimensions = await Promise.all(
    Array.from({ length: numPages }, (_, i) => getPageDimensions(pdfDoc, i))
  );

  // Compute canvas-space position of each page
  const layouts = layoutPages(dimensions);

  // Create and mount page elements
  for (let i = 0; i < numPages; i++) {
    const { x, y, width, height } = layouts[i];
    const page = new PDFPage(i, x, y, width, height);
    page.mount(container);
    pages.push(page);
  }

  // Centre viewport on the first page
  const first = layouts[0];
  const { width: sw, height: sh } = container.getBoundingClientRect();
  centreOn(first.x, first.y, first.width, first.height, sw, sh);

  // Render pages that are visible now
  triggerLazyRender();
  requestRender();
}

/**
 * @returns {string|null} Absolute path of the currently loaded PDF, or null
 */
function getCurrentPdfPath() {
  return currentPath;
}

/**
 * @returns {number} Number of pages in the current document (0 if none loaded)
 */
function getPageCount() {
  return pages.length;
}

// ---------------------------------------------------------------------------
// Lazy rendering
// ---------------------------------------------------------------------------

/**
 * Renders pages that are near the viewport and haven't been rendered yet.
 * Called after every viewport change and after initial load.
 */
function triggerLazyRender() {
  if (!pdfDoc || pages.length === 0) return;

  const { width: sw, height: sh } = container.getBoundingClientRect();

  for (const page of pages) {
    if (!page.rendered && !page.rendering && page.isNearViewport(sw, sh)) {
      page.render(pdfDoc); // fire and forget; render() handles its own errors
    }
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Destroys all current pages and resets state.
 * Called before loading a new PDF.
 */
function tearDown() {
  for (const page of pages) page.destroy();
  pages       = [];
  pdfDoc      = null;
  currentPath = null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initPDFManager, openPDF, getCurrentPdfPath, getPageCount };
