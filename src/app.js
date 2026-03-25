/**
 * app.js — Renderer process entry point
 *
 * Initialises all modules in the correct order, then wires up UI interactions
 * that span multiple modules (toolbar buttons, keyboard shortcuts).
 */

'use strict';


import { init as initRenderer, requestRender } from './canvas/renderer.js';
import { init as initInput }                   from './canvas/input.js';
import { state as viewport }                   from './canvas/viewport.js';
import { initPDFManager, openPDF, getPageCount } from './pdf/pdfManager.js';

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

// ---------------------------------------------------------------------------
// Toolbar — Open button
// ---------------------------------------------------------------------------

const btnOpen  = document.getElementById('btn-open');
const lblPage  = document.getElementById('lbl-page');
const lblZoom  = document.getElementById('lbl-zoom');

btnOpen.addEventListener('click', handleOpen);

async function handleOpen() {
  const filePath = await window.api.openFile();
  if (!filePath) return; // User cancelled

  btnOpen.disabled = true;
  btnOpen.textContent = 'Loading…';

  try {
    await openPDF(filePath);
    updateStatusBar();
  } catch (err) {
    console.error('Failed to open PDF:', err);
    alert(`Could not open PDF:\n${err.message}`);
  } finally {
    btnOpen.disabled = false;
    btnOpen.textContent = 'Open';
  }
}

// ---------------------------------------------------------------------------
// Status bar — zoom % and page count
// ---------------------------------------------------------------------------

/**
 * Updates the toolbar labels. Called after open and on every viewport change.
 */
function updateStatusBar() {
  lblZoom.textContent = `${Math.round(viewport.scale * 100)}%`;
  const count = getPageCount();
  lblPage.textContent = count > 0 ? `${count} pages` : '';
}

// Update zoom label on every viewport change
document.getElementById('canvas-container').addEventListener('viewport-changed', () => {
  updateStatusBar();
  requestRender();
});

// Initialise labels
updateStatusBar();

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'o') {
    e.preventDefault();
    handleOpen();
  }
});
