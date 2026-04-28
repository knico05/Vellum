/**
 * pageManager.js — Unified page manager (single source of truth for page layout)
 *
 * Owns the ordered page list for the current document. Both PDF pages and blank
 * pages are first-class entries. Canvas Y positions are DERIVED from list order
 * via recomputeLayout() — they are never stored independently or mutated directly.
 *
 * Insert = splice into pages[] + recomputeLayout()
 * Delete = splice out of pages[] + recomputeLayout()
 * No manual "shiftPagesAfter" needed anywhere.
 *
 * Page IDs:
 *   PDF pages:   "pdf-{pdfPageIndex}"           — stable, tied to PDF page number
 *   Blank pages: "blank-{timestamp}-{random}"   — stable, generated at creation
 *
 * Events dispatched on document:
 *   'pages-changed' — fired when a page is inserted or removed
 *
 * Exports:
 *   initPageManager, openPDF, loadPageList, getPageList,
 *   addBlankPage, removePage, resolvePageId, recomputeLayout,
 *   getCurrentPageId, getCurrentPageListIndex,
 *   goToPage, goToPageIndex, fitPage, getPageCount,
 *   getCurrentPdfPath, getCurrentFingerprint,
 *   triggerLazyRender, spliceBlankPagesFromMigration, tearDown
 */

'use strict';

import { loadPDF, getPageDimensions }                          from '../pdf/loader.js';
import { PDFPage, PAGE_GAP }                                   from '../pdf/page.js';
import { BlankPage }                                           from './blankPage.js';
import { centreOn, toCanvas, toScreen, state as viewportState } from '../canvas/viewport.js';
import { register, requestRender }                             from '../canvas/renderer.js';
import { shiftAnnotationsByPageDelta, getByPage, remove as removeAnnotation, pushPageUndo, removeAnnotationsSilent, restoreAnnotationsSilent } from '../annotations/manager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default dimensions for a new blank page (A4 at 72 dpi, same as PDF.js default) */
const BLANK_WIDTH  = 595;
const BLANK_HEIGHT = 842;

/** Maximum number of PDF.js renders running in parallel */
const MAX_CONCURRENT_RENDERS = 3;

/** Pages fetched per batch when loading dimensions for a mixed-size document */
const DIM_BATCH_SIZE = 30;

/** Number of sample pages used to detect uniform page size */
const DIM_SAMPLE_COUNT = 5;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Ordered list of page descriptors — the canonical document structure.
 * Each entry: { id, kind, width, height, canvasX, canvasY, pdfPageIndex? }
 * canvasX/canvasY are computed by recomputeLayout(), not stored in save files.
 */
let pages = [];

/** Map of page id → PDFPage | BlankPage instance (owns the DOM canvas) */
const pageInstances = new Map();

/** Cached PDF page dimensions keyed by pdfPageIndex. Set during openPDF(). */
const pdfPageDims = new Map();

/** PDF.js document proxy for the currently loaded PDF */
let pdfDoc = null;

/** Absolute path of the currently loaded PDF */
let currentPath = null;

/** SHA-256 fingerprint of the first 8KB of the current PDF */
let currentFingerprint = null;

/** #canvas-container DOM element */
let container = null;

/** Number of PDF.js renders currently in flight */
let activeRenders = 0;

/** Gap between paired pages in two-page layout (canvas units) */
const PAGE_PAIR_GAP = 20;

/** Whether pages are displayed two-per-row in two-page layout mode */
let twoPageMode = (() => {
  try { return localStorage.getItem('twoPageMode') === 'true'; } catch { return false; }
})();

/**
 * Per-page pairing map: pageId → partnerId (always stored as two-way entries).
 * Persisted to localStorage as a flat JSON object.
 */
const pairedPages = (() => {
  try {
    const raw = localStorage.getItem('qn-paired-pages');
    return raw ? new Map(Object.entries(JSON.parse(raw))) : new Map();
  } catch { return new Map(); }
})();

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Must be called once after DOM is ready.
 * Registers the per-frame position-update callback and viewport-changed listener.
 */
function init() {
  container = document.getElementById('canvas-container');

  // Reposition all page canvases every frame
  register(() => {
    for (const inst of pageInstances.values()) inst.updatePosition();
  });

  // Trigger lazy PDF page rendering whenever the viewport moves
  container.addEventListener('viewport-changed', () => {
    triggerLazyRender();
  });
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Snapshots canvasY for every page, runs layoutFn(), then shifts annotations
 * for each page whose canvasY changed. This is the single safe path for any
 * operation that moves pages (insert, remove, reorder).
 *
 * @param {Function} layoutFn — Synchronous callback that mutates pages[] and
 *                              calls recomputeLayout(). Must NOT call
 *                              _recomputeAndShift() recursively.
 */
function _recomputeAndShift(layoutFn) {
  // Snapshot X and Y positions of all existing pages BEFORE the layout change
  const before = new Map(pages.map(p => [p.id, { x: p.canvasX, y: p.canvasY }]));

  layoutFn(); // may splice pages[], will call recomputeLayout()

  // Build delta map: only pages that existed before AND moved (in X or Y or both)
  const deltas = new Map();
  for (const p of pages) {
    const old = before.get(p.id);
    if (!old) continue; // new page — no annotations to shift
    const dx = p.canvasX - old.x;
    const dy = p.canvasY - old.y;
    if (dx !== 0 || dy !== 0) deltas.set(p.id, { dx, dy });
  }

  shiftAnnotationsByPageDelta(deltas);
}

/**
 * Recomputes canvasX/canvasY for every page in pages[] based on list order.
 * Also syncs the values onto the corresponding instances so updatePosition()
 * uses the correct coordinates immediately.
 *
 * Must be called after any insert, delete, or page list replacement.
 */
function recomputeLayout() {
  let y = 0;

  if (twoPageMode && pages.length > 0) {
    for (let i = 0; i < pages.length; i += 2) {
      const pageA = pages[i];
      const pageB = pages[i + 1];

      if (pageB) {
        const totalW  = pageA.width + PAGE_PAIR_GAP + pageB.width;
        pageA.canvasX = -totalW / 2;
        pageB.canvasX = -totalW / 2 + pageA.width + PAGE_PAIR_GAP;
        pageA.canvasY = y;
        pageB.canvasY = y;

        for (const page of [pageA, pageB]) {
          const inst = pageInstances.get(page.id);
          if (inst) { inst.canvasX = page.canvasX; inst.canvasY = page.canvasY; inst.updatePosition(); }
        }

        y += Math.max(pageA.height, pageB.height) + PAGE_GAP;
      } else {
        // Odd last page — centre it alone
        pageA.canvasX = -pageA.width / 2;
        pageA.canvasY = y;
        const inst = pageInstances.get(pageA.id);
        if (inst) { inst.canvasX = pageA.canvasX; inst.canvasY = pageA.canvasY; inst.updatePosition(); }
        y += pageA.height + PAGE_GAP;
      }
    }
  } else {
    const placed = new Set();

    for (const page of pages) {
      if (placed.has(page.id)) continue;

      const partnerId = pairedPages.get(page.id);
      const partner   = partnerId ? pages.find(p => p.id === partnerId) : null;

      if (partner && !placed.has(partner.id)) {
        // Anchor page stays at its normal solo position; partner appears to its right
        page.canvasX    = -page.width / 2;
        partner.canvasX = page.canvasX + page.width + PAGE_PAIR_GAP;
        page.canvasY    = y;
        partner.canvasY = y;

        for (const p of [page, partner]) {
          const inst = pageInstances.get(p.id);
          if (inst) { inst.canvasX = p.canvasX; inst.canvasY = p.canvasY; inst.updatePosition(); }
          placed.add(p.id);
        }

        y += Math.max(page.height, partner.height) + PAGE_GAP;
      } else {
        page.canvasX = -page.width / 2;
        page.canvasY = y;

        const inst = pageInstances.get(page.id);
        if (inst) { inst.canvasX = page.canvasX; inst.canvasY = page.canvasY; inst.updatePosition(); }
        placed.add(page.id);

        y += page.height + PAGE_GAP;
      }
    }
  }

  requestRender();
}

function setTwoPageMode(enabled) {
  twoPageMode = enabled;
  try { localStorage.setItem('twoPageMode', String(enabled)); } catch { /* ignore */ }
  // Use _recomputeAndShift so annotations move with their pages (both X and Y change).
  _recomputeAndShift(() => recomputeLayout());
}

function getTwoPageMode() { return twoPageMode; }

/** Persists the pairedPages map to localStorage. */
function _savePairedPages() {
  try {
    const obj = Object.fromEntries(pairedPages);
    localStorage.setItem('qn-paired-pages', JSON.stringify(obj));
  } catch { /* ignore */ }
}

/**
 * Pairs two pages by ID so they display side-by-side.
 * Any existing partner of either page is unpaired first.
 * Dispatches 'paired-pages-changed' and triggers layout.
 *
 * @param {string} idA
 * @param {string} idB
 */
function pairPages(idA, idB) {
  if (idA === idB) return;
  // Unpair any existing partners first
  _unpairOne(idA);
  _unpairOne(idB);

  pairedPages.set(idA, idB);
  pairedPages.set(idB, idA);
  _savePairedPages();

  _recomputeAndShift(() => recomputeLayout());
  document.dispatchEvent(new CustomEvent('paired-pages-changed'));
  requestRender();
}

/**
 * Removes the pairing for a page (and its partner).
 * @param {string} id
 */
function unpairPages(id) {
  _unpairOne(id);
  _savePairedPages();
  _recomputeAndShift(() => recomputeLayout());
  document.dispatchEvent(new CustomEvent('paired-pages-changed'));
  requestRender();
}

/** Removes both directions of a pair without persisting or triggering layout. */
function _unpairOne(id) {
  const partnerId = pairedPages.get(id);
  if (partnerId) pairedPages.delete(partnerId);
  pairedPages.delete(id);
}

/**
 * Returns the partner ID of a page, or null if unpaired.
 * @param {string} id
 * @returns {string|null}
 */
function getPairedPartner(id) {
  return pairedPages.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// PDF loading
// ---------------------------------------------------------------------------

/**
 * Loads page dimensions for all pages in a PDF document efficiently.
 *
 * Fast path (common case): samples DIM_SAMPLE_COUNT pages spread across the
 * document. If all samples have identical dimensions (typical for academic PDFs),
 * the sampled size is used for every page without further fetches.
 *
 * Slow path (mixed-size PDFs): falls back to batch-fetching all pages in groups
 * of DIM_BATCH_SIZE to avoid overwhelming the PDF.js worker with hundreds of
 * concurrent requests.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} doc
 * @param {number} numPages
 * @returns {Promise<Array<{width: number, height: number}>>}
 */
async function _loadAllPageDimensions(doc, numPages) {
  if (numPages === 0) return [];

  // Sample pages spread evenly across the document
  const sampleIndices = new Set();
  for (let i = 0; i < DIM_SAMPLE_COUNT && i < numPages; i++) {
    sampleIndices.add(Math.round(i * (numPages - 1) / Math.max(DIM_SAMPLE_COUNT - 1, 1)));
  }
  const samples = await Promise.all([...sampleIndices].map(i => getPageDimensions(doc, i)));

  // Fast path: all sampled pages share the same size → assume the whole PDF is uniform
  const { width, height } = samples[0];
  if (samples.every(d => d.width === width && d.height === height)) {
    return Array.from({ length: numPages }, () => ({ width, height }));
  }

  // Slow path: mixed page sizes — fetch in batches so the worker isn't overwhelmed
  const dims = new Array(numPages);
  for (let i = 0; i < numPages; i += DIM_BATCH_SIZE) {
    const end = Math.min(i + DIM_BATCH_SIZE, numPages);
    const batch = await Promise.all(
      Array.from({ length: end - i }, (_, j) => getPageDimensions(doc, i + j))
    );
    batch.forEach((d, j) => { dims[i + j] = d; });
  }
  return dims;
}

/**
 * Opens a PDF file and builds the default page list (all PDF pages in order).
 * Called by app.js before loadPageList() — loadPageList() may then override
 * the default order with a saved order that includes blank pages.
 *
 * @param {string} filePath — Absolute path to the PDF file
 * @returns {Promise<void>}
 */
async function openPDF(filePath) {
  tearDown();
  currentPath = filePath;

  const [bytes, fingerprint] = await Promise.all([
    window.api.readFile(filePath),
    window.api.getFingerprint(filePath),
  ]);
  currentFingerprint = fingerprint;

  pdfDoc = await loadPDF(bytes);

  const numPages = pdfDoc.numPages;
  const dims     = await _loadAllPageDimensions(pdfDoc, numPages);

  // Cache dimensions for use by loadPageList()
  pdfPageDims.clear();
  dims.forEach((d, i) => pdfPageDims.set(i, d));

  // Build default page list — PDF pages only, in document order
  pages = dims.map((d, i) => ({
    id:           `pdf-${i}`,
    kind:         'pdf',
    pdfPageIndex: i,
    width:        d.width,
    height:       d.height,
    canvasX:      0,
    canvasY:      0,
  }));

  recomputeLayout();
  _mountAllPages();

  // Centre viewport on page 1
  if (pages.length > 0) {
    const first = pages[0];
    const { width: sw, height: sh } = container.getBoundingClientRect();
    centreOn(first.canvasX, first.canvasY, first.width, first.height, sw, sh);
  }

  triggerLazyRender();
  requestRender();
  document.dispatchEvent(new CustomEvent('pages-changed'));
}

// ---------------------------------------------------------------------------
// Page list persistence
// ---------------------------------------------------------------------------

/**
 * Replaces the current page list with one restored from a v2 save file.
 * Must be called after openPDF() so that pdfPageDims is populated.
 *
 * @param {Array} savedPages — The pages[] array from the v2 JSON file
 */
function loadPageList(savedPages) {
  if (!Array.isArray(savedPages) || savedPages.length === 0) return;

  // Tear down all current instances (pdfDoc remains — needed for lazy render)
  for (const inst of pageInstances.values()) inst.destroy();
  pageInstances.clear();

  pages = savedPages.map(p => {
    if (p.kind === 'pdf') {
      // Dimensions come from pdfPageDims (fetched during openPDF)
      const dims = pdfPageDims.get(p.pdfPageIndex) ?? { width: BLANK_WIDTH, height: BLANK_HEIGHT };
      return {
        id:           p.id,
        kind:         'pdf',
        pdfPageIndex: p.pdfPageIndex,
        width:        dims.width,
        height:       dims.height,
        canvasX:      0,
        canvasY:      0,
      };
    } else {
      return {
        id:       p.id,
        kind:     'blank',
        template: p.template ?? 'plain',
        width:    p.width,
        height:   p.height,
        canvasX:  0,
        canvasY:  0,
      };
    }
  });

  recomputeLayout();
  _mountAllPages();
  triggerLazyRender();
  requestRender();
  document.dispatchEvent(new CustomEvent('pages-changed'));
}

// ---------------------------------------------------------------------------
// Page operations
// ---------------------------------------------------------------------------

/**
 * Inserts a new blank page immediately after the page currently nearest the
 * viewport centre. Falls back to appending if no pages exist.
 * Dispatches 'pages-changed'.
 *
 * @param {string} [template='plain'] — 'plain' | 'lined' | 'dotted' | 'graph' | 'cornell'
 */
function addBlankPage(template = 'plain', gridSize = 24) {
  if (pages.length === 0) {
    _insertBlankPageAt(0, template, BLANK_WIDTH, BLANK_HEIGHT, gridSize);
    return;
  }

  // Find the page whose vertical centre is nearest the viewport centre
  const { width: sw, height: sh } = container.getBoundingClientRect();
  const centre  = toCanvas(sw / 2, sh / 2);
  let bestIdx   = 0;
  let bestDist  = Infinity;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const d = Math.abs((p.canvasY + p.height / 2) - centre.y);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  // Match the nearest page's dimensions so blank pages align with PDF pages
  const nearest = pages[bestIdx];
  _insertBlankPageAt(bestIdx + 1, template, nearest.width, nearest.height, gridSize);
}

/**
 * Removes a page by ID. Only blank pages can be removed — PDF pages are
 * immutable (they come from the source PDF file).
 * Dispatches 'pages-changed'.
 *
 * @param {string} id — Page ID to remove
 */
function removePage(id, _skipHistory = false) {
  const idx = pages.findIndex(p => p.id === id);
  if (idx === -1) return;

  // Snapshot page data and its annotations before removing so undo can restore them
  const pageSnapshot  = { ...pages[idx] };
  const annoSnapshot  = removeAnnotationsSilent(id);
  const partnerIdSnap = pairedPages.get(id) ?? null;

  const inst = pageInstances.get(id);
  if (inst) {
    inst.destroy();
    pageInstances.delete(id);
  }

  if (pairedPages.has(id)) {
    _unpairOne(id);
    _savePairedPages();
  }

  _recomputeAndShift(() => {
    pages.splice(idx, 1);
    recomputeLayout();
  });

  document.dispatchEvent(new CustomEvent('pages-changed'));
  requestRender();

  if (!_skipHistory) {
    pushPageUndo(
      // undo: restore the page at its original index with its annotations and pairing
      () => {
        _recomputeAndShift(() => {
          const insertIdx = Math.min(idx, pages.length);
          pages.splice(insertIdx, 0, { ...pageSnapshot, canvasX: 0, canvasY: 0 });
          recomputeLayout();
        });
        // Mount only the restored page — _mountAllPages() would duplicate all existing instances
        const restored = pages.find(p => p.id === id);
        if (restored && !pageInstances.has(id)) {
          let inst;
          if (restored.kind === 'pdf') {
            inst = new PDFPage(restored.pdfPageIndex, restored.canvasX, restored.canvasY, restored.width, restored.height);
          } else {
            inst = new BlankPage(restored.width, restored.height, restored.template ?? 'plain', restored.gridSize ?? 24);
            inst.canvasX = restored.canvasX;
            inst.canvasY = restored.canvasY;
          }
          inst.mount(container);
          pageInstances.set(id, inst);
        }
        if (partnerIdSnap && pages.find(p => p.id === partnerIdSnap)) {
          pairedPages.set(id, partnerIdSnap);
          pairedPages.set(partnerIdSnap, id);
          _savePairedPages();
        }
        restoreAnnotationsSilent(annoSnapshot);
        triggerLazyRender();
        document.dispatchEvent(new CustomEvent('pages-changed'));
        requestRender();
      },
      // redo: remove the page again (skip history to avoid double-pushing)
      () => removePage(id, true),
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Inserts a new blank page at position listIndex in pages[].
 * Mounts a BlankPage instance and dispatches 'pages-changed'.
 *
 * @param {number} listIndex — Index at which to splice in the new page
 * @param {string} [template='plain'] — Template to apply to the blank page
 * @param {number} [width]   — Page width in canvas units (defaults to nearest page or A4)
 * @param {number} [height]  — Page height in canvas units
 */
function _insertBlankPageAt(listIndex, template = 'plain', width = BLANK_WIDTH, height = BLANK_HEIGHT, gridSize = 24) {
  const id   = `blank-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const page = {
    id,
    kind:     'blank',
    template,
    gridSize,
    width,
    height,
    canvasX:  0,
    canvasY:  0,
  };

  _recomputeAndShift(() => {
    pages.splice(listIndex, 0, page);
    recomputeLayout(); // sets page.canvasX/canvasY
  });

  const inst = new BlankPage(page.width, page.height, template, gridSize);
  inst.canvasX = page.canvasX;
  inst.canvasY = page.canvasY;
  inst.mount(container);
  pageInstances.set(id, inst);

  document.dispatchEvent(new CustomEvent('pages-changed'));
  requestRender();
}

/**
 * Creates and mounts instances for all entries in pages[].
 * Called after any full page list replacement (openPDF, loadPageList, migration).
 * Assumes pages[] has been set and recomputeLayout() has been called.
 */
function _mountAllPages() {
  for (const page of pages) {
    let inst;
    if (page.kind === 'pdf') {
      inst = new PDFPage(page.pdfPageIndex, page.canvasX, page.canvasY, page.width, page.height);
    } else {
      inst = new BlankPage(page.width, page.height, page.template ?? 'plain', page.gridSize ?? 24);
      inst.canvasX = page.canvasX;
      inst.canvasY = page.canvasY;
    }
    inst.mount(container);
    pageInstances.set(page.id, inst);
  }
}

// ---------------------------------------------------------------------------
// Lazy PDF rendering
// ---------------------------------------------------------------------------

/**
 * Returns true if the page is far enough from the viewport to warrant
 * unloading its pixel buffer. "Far" = more than 3 screen-heights away.
 * The generous margin prevents thrashing (render → unload → render) during
 * slow scrolls.
 *
 * @param {PDFPage} inst
 * @param {number} sw — Container width in pixels
 * @param {number} sh — Container height in pixels
 * @returns {boolean}
 */
function isFarFromViewport(inst, sw, sh) {
  const { x, y }    = toScreen(inst.canvasX, inst.canvasY);
  const { x: x2, y: y2 } = toScreen(inst.canvasX + inst.width, inst.canvasY + inst.height);
  // 2× hysteresis: wide enough to avoid thrash during slow scrolls, tight
  // enough to free memory sooner than the old 3× threshold.
  const margin = sh * 2;
  return x2 < -margin || y2 < -margin || x > sw + margin || y > sh + margin;
}

/**
 * Renders PDF pages near the viewport that haven't been rendered yet, and
 * unloads pixel buffers for pages far off-screen to bound memory usage.
 * Limits concurrent PDF.js renders to MAX_CONCURRENT_RENDERS.
 * Blank pages are already rendered (white fill at mount time) — no-op for them.
 */
function triggerLazyRender() {
  if (!pdfDoc || pages.length === 0) return;

  const { width: sw, height: sh } = container.getBoundingClientRect();

  for (const page of pages) {
    if (page.kind !== 'pdf') continue;
    const inst = pageInstances.get(page.id);
    if (!inst) continue;

    if (inst.isNearViewport(sw, sh)) {
      if (!inst.rendered && !inst.rendering) {
        if (activeRenders >= MAX_CONCURRENT_RENDERS) continue;
        activeRenders++;
        inst.render(pdfDoc).finally(() => {
          activeRenders--;
          // Re-trigger so queued pages get a slot now that one finished
          triggerLazyRender();
        });
      }
    } else if (inst.rendered && isFarFromViewport(inst, sw, sh)) {
      // Free pixel memory for pages far off-screen; they will re-render on demand
      inst.unload();
    }
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Centres the viewport on the page with the given ID.
 * @param {string} id
 */
function goToPage(id) {
  const page = pages.find(p => p.id === id);
  if (!page) return;
  const { width: sw, height: sh } = container.getBoundingClientRect();
  centreOn(page.canvasX, page.canvasY, page.width, page.height, sw, sh);
  requestRender();
  triggerLazyRender(); // Ensure the newly visible page renders immediately
}

/**
 * Centres the viewport on the page at list position n.
 * Clamps to valid range.
 * @param {number} n — 0-based list index
 */
function goToPageIndex(n) {
  const clamped = Math.max(0, Math.min(pages.length - 1, n));
  const page    = pages[clamped];
  if (page) goToPage(page.id);
}

/**
 * Fits the most-visible page into the viewport (centres + scales to fill).
 */
function fitPage() {
  if (pages.length === 0) return;

  const { width: sw, height: sh } = container.getBoundingClientRect();
  const screenCentreY = sh / 2;

  let bestPage = pages[0];
  let bestDist = Infinity;

  for (const page of pages) {
    const { y: sy } = toScreen(page.canvasX, page.canvasY + page.height / 2);
    const dist = Math.abs(sy - screenCentreY);
    if (dist < bestDist) { bestDist = dist; bestPage = page; }
  }

  centreOn(bestPage.canvasX, bestPage.canvasY, bestPage.width, bestPage.height, sw, sh);
  requestRender();
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Moves a page from one list position to another.
 * Recomputes layout and dispatches 'pages-changed'.
 *
 * @param {number} fromIdx — Current 0-based index of the page
 * @param {number} toIdx   — Target 0-based index (after the move)
 */
function movePage(fromIdx, toIdx, _skipHistory = false) {
  if (fromIdx === toIdx) return;
  if (fromIdx < 0 || fromIdx >= pages.length) return;
  if (toIdx   < 0 || toIdx   >= pages.length) return;

  _recomputeAndShift(() => {
    const [page] = pages.splice(fromIdx, 1);
    pages.splice(toIdx, 0, page);
    recomputeLayout();
  });

  document.dispatchEvent(new CustomEvent('pages-changed'));
  requestRender();

  if (!_skipHistory) {
    pushPageUndo(
      () => movePage(toIdx, fromIdx, true),
      () => movePage(fromIdx, toIdx, true),
    );
  }
}

/**
 * Returns a read-only snapshot of the ordered page list.
 * Each entry: { id, kind, width, height, canvasX, canvasY, pdfPageIndex? }
 *
 * @returns {Array<object>}
 */
function getPageList() {
  return pages.map(p => ({ ...p }));
}

/**
 * Hit-tests a canvas-space point against the page list.
 * Returns the ID of the page that contains the point, or the first page's ID
 * if no page matches (fallback for annotations drawn outside all pages).
 *
 * @param {number} cx — Canvas X
 * @param {number} cy — Canvas Y
 * @returns {string|null}
 */
function resolvePageId(cx, cy) {
  for (const page of pages) {
    if (
      cx >= page.canvasX && cx <= page.canvasX + page.width &&
      cy >= page.canvasY && cy <= page.canvasY + page.height
    ) return page.id;
  }
  return pages[0]?.id ?? null;
}

/**
 * Returns the ID of the page whose vertical centre is nearest the viewport centre.
 * @returns {string|null}
 */
function getCurrentPageId() {
  if (pages.length === 0) return null;

  const { width: sw, height: sh } = container.getBoundingClientRect();
  const centre  = toCanvas(sw / 2, sh / 2);
  let bestId    = pages[0].id;
  let bestDist  = Infinity;

  for (const page of pages) {
    const d = Math.abs((page.canvasY + page.height / 2) - centre.y);
    if (d < bestDist) { bestDist = d; bestId = page.id; }
  }
  return bestId;
}

/**
 * Returns the 0-based list index of the page nearest the viewport centre.
 * @returns {number}
 */
function getCurrentPageListIndex() {
  const id = getCurrentPageId();
  if (id === null) return 0;
  const idx = pages.findIndex(p => p.id === id);
  return idx === -1 ? 0 : idx;
}

/** @returns {number} Total number of pages (PDF + blank) */
function getPageCount()          { return pages.length; }

/** @returns {string|null} Absolute path of the loaded PDF, or null */
function getCurrentPdfPath()     { return currentPath; }

/** @returns {string|null} SHA-256 fingerprint of the loaded PDF, or null */
function getCurrentFingerprint() { return currentFingerprint; }

/**
 * Returns the PDF.js document proxy for the currently loaded PDF.
 * Used by the export module to render individual pages to offscreen canvases.
 * @returns {import('pdfjs-dist').PDFDocumentProxy|null}
 */
function getPdfDoc() { return pdfDoc; }

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Destroys all page instances and resets all state.
 * Called before loading a new PDF.
 */
function tearDown() {
  for (const inst of pageInstances.values()) inst.destroy();
  pageInstances.clear();
  pages              = [];
  pdfPageDims.clear();
  // Release PDF.js memory (worker buffers, decoded image data)
  if (pdfDoc) { pdfDoc.destroy().catch(() => {}); }
  pdfDoc             = null;
  currentPath        = null;
  currentFingerprint = null;
}

// ---------------------------------------------------------------------------
// v1 migration helper
// ---------------------------------------------------------------------------

/**
 * Splices blank pages from a v1 file migration into the current page list.
 * Called from app.js after openPDF() and after the initial page list is built.
 *
 * Each blankDescriptor has: { id, kind:'blank', width, height, _canvasY }
 * The _canvasY value is the Y the blank page had in the old canvas coordinate
 * system, used to determine where it falls relative to PDF pages.
 *
 * After splicing, destroys and rebuilds all instances with the merged layout.
 *
 * @param {Array} blankDescriptors — From serialiser.migrateV1()
 */
function spliceBlankPagesFromMigration(blankDescriptors) {
  if (!blankDescriptors || blankDescriptors.length === 0) return;

  // Insert each blank page at the correct position relative to PDF pages.
  // Because recomputeLayout() hasn't run for blanks yet we compare _canvasY
  // against the current computed canvasY values on the PDF pages.
  for (const desc of blankDescriptors) {
    let insertIdx = pages.length; // default: after everything
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].canvasY > desc._canvasY) {
        insertIdx = i;
        break;
      }
    }
    pages.splice(insertIdx, 0, {
      id:      desc.id,
      kind:    'blank',
      width:   desc.width,
      height:  desc.height,
      canvasX: 0,
      canvasY: 0,
    });
  }

  // Tear down all instances and rebuild with the merged layout
  for (const inst of pageInstances.values()) inst.destroy();
  pageInstances.clear();

  recomputeLayout();
  _mountAllPages();
  triggerLazyRender();
  requestRender();

  document.dispatchEvent(new CustomEvent('pages-changed'));
}

/**
 * Returns true if a page with the given ID exists in the current page list.
 * Used by app.js to validate a stored last-page ID before navigating to it.
 *
 * @param {string} pageId
 * @returns {boolean}
 */
function pageExists(pageId) {
  return pages.some(p => p.id === pageId);
}

/**
 * Briefly adds a CSS flash class to the page element so the user can see
 * which page a search result landed on. The class removes itself after the
 * animation completes (~1.5 s).
 *
 * @param {string} id — page id
 */
function flashPage(id) {
  const inst = pageInstances.get(id);
  if (!inst?.element) return;
  inst.element.classList.remove('page-flash');
  // Force reflow so re-adding the class restarts the animation
  void inst.element.offsetWidth;
  inst.element.classList.add('page-flash');
  setTimeout(() => inst.element.classList.remove('page-flash'), 1600);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  init as initPageManager,
  openPDF,
  loadPageList,
  getPageList,
  addBlankPage,
  removePage,
  movePage,
  resolvePageId,
  recomputeLayout,
  setTwoPageMode,
  getTwoPageMode,
  pairPages,
  unpairPages,
  getPairedPartner,
  getCurrentPageId,
  getCurrentPageListIndex,
  goToPage,
  goToPageIndex,
  fitPage,
  getPageCount,
  getCurrentPdfPath,
  getCurrentFingerprint,
  getPdfDoc,
  triggerLazyRender,
  spliceBlankPagesFromMigration,
  pageExists,
  flashPage,
  tearDown,
};
