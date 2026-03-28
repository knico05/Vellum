/**
 * app.js — Renderer process entry point
 *
 * Initialises all modules in the correct order, then wires up UI interactions
 * that span multiple modules (toolbar buttons, keyboard shortcuts, notes panel).
 *
 * Module initialisation order matters:
 *   1. Canvas renderer and input (foundation everything sits on)
 *   2. Page manager (replaces pdfManager + blankpage — owns all pages)
 *   3. Annotation tools (register renderer draw callbacks, attach pointer listeners)
 *   4. UI modules (toolbar, shortcuts, panel — read state from the above)
 *   5. Auto-save (last, so it doesn't trigger before state is ready)
 */

'use strict';

import { init as initRenderer, requestRender }    from './canvas/renderer.js';
import { init as initInput }                      from './canvas/input.js';
import { state as viewport }                      from './canvas/viewport.js';
import {
  initPageManager, openPDF as openPDFPages, loadPageList, getPageCount,
  getCurrentFingerprint, getCurrentPdfPath, goToPageIndex, fitPage, addBlankPage,
  getCurrentPageListIndex, spliceBlankPagesFromMigration,
  getPdfDoc, getPageList, goToPage,
} from './pages/pageManager.js';
import { clear, loadFromJSON, undo, redo }         from './annotations/manager.js';
import { initAutosave }                           from './storage/autosave.js';
import { deserialise }                            from './storage/serialiser.js';
import { initHighlight }                          from './annotations/highlight.js';
import { initDraw }                               from './annotations/draw.js';
import { initNotes }                              from './annotations/note.js';
import { initEraser }                             from './annotations/eraser.js';
import { initImages, pasteImageAtCenter }         from './annotations/image.js';
import { initSelect }                             from './annotations/select.js';
import { init as initToolbar, setActiveTool, getActiveTool, updateStatus } from './ui/toolbar.js';
import { init as initShortcuts }                  from './ui/shortcuts.js';
import { initScreenshot, activateScreenshot }     from './ui/screenshot.js';
import { init as initPanel, loadPageNotes, getCurrentPageIndex, togglePanel,
         addBlankPageWithPicker } from './ui/panel.js';
import { initLibrary, addToLibrary }              from './ui/library.js';
import { exportToPdf }                            from './export/pdfExport.js';
import { initSearch, showSearch }                 from './ui/search.js';
import { search as searchText, clearCache as clearSearchCache } from './pdf/textSearch.js';

// ---------------------------------------------------------------------------
// Title bar window controls
// ---------------------------------------------------------------------------

document.getElementById('btn-minimise').addEventListener('click', () => {
  window.api.windowControl('minimise');
});
document.getElementById('btn-maximise').addEventListener('click', () => {
  window.api.windowControl('maximise');
});
document.getElementById('btn-close').addEventListener('click', () => {
  window.api.windowControl('close');
});

// ---------------------------------------------------------------------------
// Module initialisation (order matters)
// ---------------------------------------------------------------------------

initRenderer();       // Creates <canvas>, starts animation loop
initInput();          // Attaches pan/zoom listeners
initPageManager();    // Owns all pages (PDF + blank); replaces pdfManager + blankpage
initHighlight();      // Registers draw callbacks, attaches pointer listeners
initDraw();           // Registers draw callbacks, attaches pointer listeners
initNotes();          // Manages sticky note DOM elements
initEraser();         // Registers pointer listeners for the eraser tool
initImages();         // Manages image annotation DOM elements
initSelect();         // Registers pointer listeners and overlay draw for select/move tool
initToolbar();        // Builds toolbar UI, owns activeTool state
initPanel();          // Builds notes panel UI, owns per-page notes state
initShortcuts({       // Wires up global keyboard shortcuts
  openFile:   handleOpen,
  setTool:    setActiveTool,
  undo,
  redo,
  fitPage,
  screenshot: activateScreenshot,
  prevPage: () => {
    const cur = getCurrentPageListIndex();
    if (cur > 0) goToPageIndex(cur - 1);
  },
  nextPage: () => {
    const cur = getCurrentPageListIndex();
    if (cur < getPageCount() - 1) goToPageIndex(cur + 1);
  },
  togglePanel,
  openSearch: showSearch,
});
initAutosave();       // Listens for changes, writes to disk
initScreenshot();     // Creates screenshot overlay DOM, attaches listeners
initLibrary(openFromLibrary); // File library drawer
initSearch({          // Search bar (Ctrl+F)
  onSearch: (query) => searchText(getPdfDoc(), getPageList(), query),
  onNavigate: (match) => goToPage(match.pageId),
});

// ---------------------------------------------------------------------------
// Toolbar — Open button and action buttons
// ---------------------------------------------------------------------------

const btnOpen = document.getElementById('btn-open');
btnOpen.addEventListener('click', handleOpen);

document.getElementById('btn-fit-page').addEventListener('click', fitPage);
document.getElementById('btn-screenshot').addEventListener('click', activateScreenshot);
document.getElementById('btn-new-page').addEventListener('click', (e) => {
  addBlankPageWithPicker(e.currentTarget);
});
document.getElementById('btn-export').addEventListener('click', handleExport);
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);

async function handleOpen() {
  const filePath = await window.api.openFile();
  if (!filePath) return; // User cancelled
  await loadFile(filePath);
}

/**
 * Exports the current document as a flattened PDF.
 * Renders each page + its annotations to an offscreen canvas at 2× resolution,
 * then assembles them into a single PDF the user can share with anyone.
 */
async function handleExport() {
  const pdfPath  = getCurrentPdfPath();
  const btnExport  = document.getElementById('btn-export');
  const lblStatus  = document.getElementById('lbl-save-status');

  // Derive a default filename: "lecture3.pdf" → "lecture3-annotated.pdf"
  let defaultName = 'annotated.pdf';
  if (pdfPath) {
    const base = pdfPath.replace(/\\/g, '/').split('/').pop().replace(/\.pdf$/i, '');
    defaultName = `${base}-annotated.pdf`;
  }

  const savePath = await window.api.savePdfDialog(defaultName);
  if (!savePath) return; // User cancelled

  btnExport.disabled    = true;
  btnExport.textContent = 'Exporting…';
  lblStatus.textContent = 'Exporting…';

  try {
    const pdfBytes = await exportToPdf((current, total) => {
      lblStatus.textContent = `Exporting ${current + 1} / ${total}…`;
    });

    await window.api.writeBinary(savePath, pdfBytes);

    lblStatus.textContent = 'Exported!';
    setTimeout(() => { lblStatus.textContent = ''; }, 2500);
  } catch (err) {
    console.error('Export failed:', err);
    alert(`Export failed:\n${err?.message ?? String(err)}`);
    lblStatus.textContent = '';
  } finally {
    btnExport.disabled    = false;
    btnExport.textContent = 'Export PDF';
  }
}

/**
 * Called by the library panel when the user clicks a file entry.
 * @param {string} filePath
 */
async function openFromLibrary(filePath) {
  await loadFile(filePath);
}

/**
 * Core file load routine — used by both handleOpen and openFromLibrary.
 * @param {string} filePath — Absolute path to the PDF
 */
async function loadFile(filePath) {
  btnOpen.disabled    = true;
  btnOpen.textContent = 'Loading…';

  // Update window title to reflect the open file
  const filename = filePath.replace(/\\/g, '/').split('/').pop();
  document.title = `${filename} — QuickNotes`;

  try {
    // 1. Load the PDF — builds the default page list (PDF pages only)
    await openPDFPages(filePath);

    // 2. Discard annotations and search state from any previous document
    clear();
    clearSearchCache();

    // 3. Load saved annotations and page list (if any)
    await tryLoadAnnotations(filePath);

    // 4. Record in library
    await addToLibrary(filePath);

    updateStatusBar();
  } catch (err) {
    console.error('Failed to open PDF:', err);
    alert(`Could not open PDF:\n${err?.message ?? String(err)}`);
  } finally {
    btnOpen.disabled    = false;
    btnOpen.textContent = 'Open';
  }
}

// ---------------------------------------------------------------------------
// Annotation load on open
// ---------------------------------------------------------------------------

/**
 * Loads saved annotations for the given PDF from the app's annotations store
 * (userData/annotations/<hash>.json).
 *
 * Migration: if no file exists at the new path but a legacy sidecar
 * (.annotations.json next to the PDF) does, copies it to the new location
 * on first open. The sidecar is left in place and ignored from that point on.
 *
 * @param {string} pdfPath — Absolute path of the just-opened PDF
 */
async function tryLoadAnnotations(pdfPath) {
  const jsonPath = await window.api.getAnnotationsPath(pdfPath);
  let exists     = await window.api.fileExists(jsonPath);

  // One-time migration from legacy sidecar format
  if (!exists) {
    const sidecarPath = pdfPath.replace(/\.pdf$/i, '.annotations.json');
    if (await window.api.fileExists(sidecarPath)) {
      try {
        const bytes = await window.api.readFile(sidecarPath);
        await window.api.writeFile(jsonPath, new TextDecoder().decode(bytes));
        exists = true;
      } catch (err) {
        console.warn('Could not migrate sidecar annotations:', err.message);
      }
    }
  }

  if (!exists) return;

  try {
    const bytes  = await window.api.readFile(jsonPath);
    const text   = new TextDecoder().decode(bytes);
    const result = deserialise(text);

    // Fingerprint check — warn if annotations were made for a different PDF version
    const currentFp = getCurrentFingerprint();
    if (result.pdfFingerprint && currentFp && result.pdfFingerprint !== currentFp) {
      console.warn(
        'Annotation fingerprint mismatch — annotations may not align with this PDF version.'
      );
    }

    if (result._migratedFrom === 1) {
      // v1 migration: page list was built from PDF only in openPDF().
      // Splice blank pages into the list at the correct positions.
      spliceBlankPagesFromMigration(result._blankPageDescriptors ?? []);
    } else if (result.pages) {
      // v2: restore full saved page order (may include blank pages)
      loadPageList(result.pages);
    }

    loadFromJSON(result.annotations);
    loadPageNotes(result.pageNotes);
  } catch (err) {
    console.error('Failed to load annotations:', err);
  }
}

// ---------------------------------------------------------------------------
// Status bar — zoom % and page count
// ---------------------------------------------------------------------------

/**
 * Updates toolbar labels. Called after open and on every viewport change.
 */
function updateStatusBar() {
  updateStatus({
    pageCount:   getPageCount(),
    currentPage: getCurrentPageIndex(),
    scale:       viewport.scale,
  });
}

// Update zoom label on every viewport change
document.getElementById('canvas-container').addEventListener('viewport-changed', () => {
  updateStatusBar();
  requestRender();
});

// Pen auto-draw — when cursor (no tool) is active and the user touches down
// with a stylus, automatically switch to draw so sketching starts immediately.
document.getElementById('canvas-container').addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'pen') return;
  if (getActiveTool() === null) setActiveTool('draw');
}, { capture: true });

// Ctrl+V — paste clipboard image onto canvas
document.addEventListener('keydown', async (e) => {
  if (!(e.key === 'v' && (e.ctrlKey || e.metaKey))) return;
  const tag      = document.activeElement?.tagName?.toLowerCase();
  const editable = document.activeElement?.isContentEditable;
  if (tag === 'input' || tag === 'textarea' || editable) return;
  await pasteImageAtCenter();
});

// Initialise labels
updateStatusBar();
