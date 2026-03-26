/**
 * app.js — Renderer process entry point
 *
 * Initialises all modules in the correct order, then wires up UI interactions
 * that span multiple modules (toolbar buttons, keyboard shortcuts, notes panel).
 *
 * Module initialisation order matters:
 *   1. Canvas renderer and input (foundation everything sits on)
 *   2. PDF manager (registers renderer draw callback)
 *   3. Annotation tools (register renderer draw callbacks, attach pointer listeners)
 *   4. UI modules (toolbar, shortcuts, panel — read state from the above)
 *   5. Auto-save (last, so it doesn't trigger before state is ready)
 */

'use strict';


import { init as initRenderer, requestRender } from './canvas/renderer.js';
import { init as initInput }                   from './canvas/input.js';
import { state as viewport }                    from './canvas/viewport.js';
import { initPDFManager, openPDF, getPageCount, getCurrentFingerprint, goToPage, fitPage } from './pdf/pdfManager.js';
import { clear, loadFromJSON, undo }           from './annotations/manager.js';
import { initAutosave }                        from './storage/autosave.js';
import { deserialise, annotationsPath }        from './storage/serialiser.js';
import { initHighlight }                       from './annotations/highlight.js';
import { initDraw }                            from './annotations/draw.js';
import { initNotes }                           from './annotations/note.js';
import { initEraser }                          from './annotations/eraser.js';
import { initImages }                          from './annotations/image.js';
import { initSelect }                          from './annotations/select.js';
import { init as initToolbar, setActiveTool, updateStatus } from './ui/toolbar.js';
import { init as initShortcuts }               from './ui/shortcuts.js';
import { initScreenshot, activateScreenshot }  from './ui/screenshot.js';
import { initFloatingToolbar }                from './ui/floatingtoolbar.js';
import { init as initPanel, loadPageNotes, getCurrentPageIndex } from './ui/panel.js';
import { initLibrary, addToLibrary } from './ui/library.js';

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

initRenderer();      // Creates <canvas>, starts animation loop
initInput();         // Attaches pan/zoom listeners
initPDFManager();    // Registers draw callback, lazy-render listener
initHighlight();     // Registers draw callbacks, attaches pointer listeners
initDraw();          // Registers draw callbacks, attaches pointer listeners
initNotes();         // Manages sticky note DOM elements
initEraser();        // Registers pointer listeners for the eraser tool
initImages();        // Manages image annotation DOM elements
initSelect();        // Registers pointer listeners and overlay draw for select/move tool
initToolbar();       // Builds toolbar UI, owns activeTool state
initPanel();         // Builds notes panel UI, owns per-page notes state
initShortcuts({      // Wires up global keyboard shortcuts
  openFile:   handleOpen,
  setTool:    setActiveTool,
  undo,
  fitPage,
  screenshot: activateScreenshot,
  prevPage: () => {
    const cur = getCurrentPageIndex();
    if (cur !== null) goToPage(cur - 1);
  },
  nextPage: () => {
    const cur = getCurrentPageIndex();
    if (cur !== null) goToPage(cur + 1);
  },
});
initAutosave();      // Listens for annotation changes, writes to disk
initScreenshot();       // Creates screenshot overlay DOM, attaches listeners
initFloatingToolbar();  // Floating pen-friendly tool palette
initLibrary(openFromLibrary); // File library drawer

// ---------------------------------------------------------------------------
// Toolbar — Open button
// ---------------------------------------------------------------------------

const btnOpen = document.getElementById('btn-open');
btnOpen.addEventListener('click', handleOpen);

document.getElementById('btn-fit-page').addEventListener('click', fitPage);
document.getElementById('btn-screenshot').addEventListener('click', activateScreenshot);

async function handleOpen() {
  const filePath = await window.api.openFile();
  if (!filePath) return; // User cancelled
  await loadFile(filePath);
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

  try {
    await openPDF(filePath);
    clear();                          // Discard annotations from previous PDF
    await tryLoadAnnotations(filePath);
    await addToLibrary(filePath);     // Record in persistent library
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
 * Checks for a companion .annotations.json file next to the given PDF.
 * If found, parses it and loads annotations and page notes into their
 * respective modules.
 * Warns (but still loads) if the fingerprint doesn't match the current PDF.
 *
 * @param {string} pdfPath — Absolute path of the just-opened PDF
 */
async function tryLoadAnnotations(pdfPath) {
  const jsonPath = annotationsPath(pdfPath);
  const exists   = await window.api.fileExists(jsonPath);
  if (!exists) return;

  try {
    const bytes  = await window.api.readFile(jsonPath);
    const text   = new TextDecoder().decode(bytes);
    const { pdfFingerprint, annotations, pageNotes } = deserialise(text);

    // Fingerprint check — warn if the JSON was made for a different version
    // of the PDF (e.g. the file was replaced but the JSON wasn't)
    const currentFp = getCurrentFingerprint();
    if (pdfFingerprint && currentFp && pdfFingerprint !== currentFp) {
      console.warn(
        'Annotation fingerprint mismatch — annotations may not align with this PDF version.'
      );
    }

    loadFromJSON(annotations);
    loadPageNotes(pageNotes);
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

// Note: keyboard zoom (+, -, Ctrl+0) is handled by canvas/input.js directly.

// Initialise labels
updateStatusBar();
