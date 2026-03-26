/**
 * panel.js — Right-side notes panel for per-page text notes
 *
 * The notes panel shows a textarea for the "current page" — the page whose
 * vertical centre is nearest the vertical centre of the screen. It updates
 * as the user pans/zooms through the document.
 *
 * Notes are stored in a Map<pageIndex, string> inside this module.
 * getPageNotes() returns a plain object for serialisation by autosave.js.
 * loadPageNotes() restores state from a parsed .annotations.json file.
 *
 * Text changes are debounced 800ms before writing to the map, to avoid
 * emitting annotations-changed on every keystroke while typing quickly.
 *
 * Imports:
 *   viewport.js    — toCanvas() to convert screen centre to canvas space
 *   pdfManager.js  — getPages() to get page layout for current-page detection
 *
 * Exports: init(), getPageNotes(), loadPageNotes()
 */

'use strict';

import { toCanvas }  from '../canvas/viewport.js';
import { getPages }  from '../pdf/pdfManager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 800;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Per-page notes, keyed by pageIndex (number) */
const pageNotes = new Map();

/** Index of the page currently shown in the panel, or null */
let currentPageIndex = null;

/** Debounce timer handle */
let saveTimer = null;

/** DOM references */
let textareaEl   = null;
let pageLabelEl  = null;
let emptyMsgEl   = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Builds the panel UI and attaches listeners.
 * Must be called once after the DOM is ready.
 */
function init() {
  const panel = document.getElementById('notes-panel');
  if (!panel) return;

  // Clear any placeholder content
  panel.innerHTML = '';

  // Header row
  const header = document.createElement('div');
  header.className   = 'panel-header';
  header.textContent = 'Page Notes';
  panel.appendChild(header);

  // "Page N" sub-label
  pageLabelEl = document.createElement('div');
  pageLabelEl.className   = 'panel-page-label';
  pageLabelEl.textContent = '';
  panel.appendChild(pageLabelEl);

  // Textarea
  textareaEl = document.createElement('textarea');
  textareaEl.className   = 'panel-textarea';
  textareaEl.placeholder = 'Notes for this page…';
  textareaEl.spellcheck  = true;
  panel.appendChild(textareaEl);

  // Empty state message shown when no PDF is loaded
  emptyMsgEl = document.createElement('div');
  emptyMsgEl.className   = 'panel-empty';
  emptyMsgEl.textContent = 'Open a PDF to start taking notes per page.';
  panel.appendChild(emptyMsgEl);

  showEmptyState();

  // Textarea input — debounced save to map
  textareaEl.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushCurrentNote, DEBOUNCE_MS);
  });

  // Update current page when viewport changes
  document.getElementById('canvas-container')?.addEventListener(
    'viewport-changed',
    updateCurrentPage
  );
}

// ---------------------------------------------------------------------------
// Current-page detection
// ---------------------------------------------------------------------------

/**
 * Determines which page is "current" by finding the page whose vertical centre
 * in canvas space is nearest to the vertical centre of the screen.
 *
 * Called after every viewport change so the panel tracks the user's position.
 */
function updateCurrentPage() {
  const pages = getPages();
  if (pages.length === 0) {
    currentPageIndex = null;
    showEmptyState();
    return;
  }

  const container = document.getElementById('canvas-container');
  if (!container) return;

  const { width: sw, height: sh } = container.getBoundingClientRect();

  // The canvas-space point at the centre of the screen
  const centre = toCanvas(sw / 2, sh / 2);

  // Find the page with the closest vertical centre in canvas space
  let closestIndex = 0;
  let closestDist  = Infinity;

  for (const page of pages) {
    const pageCentreY = page.canvasY + page.height / 2;
    const dist = Math.abs(pageCentreY - centre.y);
    if (dist < closestDist) {
      closestDist  = dist;
      closestIndex = page.pageIndex;
    }
  }

  if (closestIndex !== currentPageIndex) {
    // Flush any pending note for the old page before switching
    flushCurrentNote();
    currentPageIndex = closestIndex;
    loadCurrentPageIntoUI();
  }
}

// ---------------------------------------------------------------------------
// UI state helpers
// ---------------------------------------------------------------------------

/**
 * Loads the note for the current page into the textarea.
 */
function loadCurrentPageIntoUI() {
  if (currentPageIndex === null) {
    showEmptyState();
    return;
  }

  // Show textarea, hide empty message
  if (textareaEl)  textareaEl.style.display  = '';
  if (emptyMsgEl)  emptyMsgEl.style.display  = 'none';

  if (pageLabelEl) {
    pageLabelEl.textContent = `Page ${currentPageIndex + 1}`;
  }

  if (textareaEl) {
    textareaEl.value = pageNotes.get(currentPageIndex) ?? '';
  }
}

/**
 * Shows the empty state message and hides the textarea.
 */
function showEmptyState() {
  if (textareaEl)  textareaEl.style.display  = 'none';
  if (emptyMsgEl)  emptyMsgEl.style.display  = '';
  if (pageLabelEl) pageLabelEl.textContent   = '';
}

// ---------------------------------------------------------------------------
// Note persistence (in-memory)
// ---------------------------------------------------------------------------

/**
 * Writes the current textarea content to the pageNotes map immediately.
 * Fires 'annotations-changed' so autosave picks up the change.
 * Called by the debounce timer and also when the current page changes.
 */
function flushCurrentNote() {
  clearTimeout(saveTimer);
  saveTimer = null;

  if (currentPageIndex === null || !textareaEl) return;

  const text = textareaEl.value;

  const previous = pageNotes.get(currentPageIndex) ?? '';
  if (text === previous) return; // No change — skip emit

  if (text.trim() === '') {
    pageNotes.delete(currentPageIndex);
  } else {
    pageNotes.set(currentPageIndex, text);
  }

  // Notify autosave
  document.dispatchEvent(new CustomEvent('annotations-changed'));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns all page notes as a plain object keyed by string page index.
 * Used by autosave.js to include notes in the serialised JSON.
 *
 * @returns {{ [pageIndex: string]: string }}
 */
function getPageNotes() {
  const obj = {};
  for (const [index, text] of pageNotes) {
    if (text && text.trim() !== '') {
      obj[String(index)] = text;
    }
  }
  return obj;
}

/**
 * Replaces the in-memory notes state from a parsed annotation file.
 * Called after a PDF with saved annotations is opened.
 *
 * @param {{ [pageIndex: string]: string }} notesObj — From deserialise()
 */
function loadPageNotes(notesObj) {
  pageNotes.clear();

  if (!notesObj || typeof notesObj !== 'object') return;

  for (const [key, text] of Object.entries(notesObj)) {
    const index = parseInt(key, 10);
    if (!isNaN(index) && text && typeof text === 'string') {
      pageNotes.set(index, text);
    }
  }

  // Refresh the UI if a page is already showing
  if (currentPageIndex !== null) {
    loadCurrentPageIntoUI();
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Returns the 0-based index of the currently visible page, or null.
 * Used by app.js for prev/next page navigation and status bar.
 *
 * @returns {number|null}
 */
function getCurrentPageIndex() {
  return currentPageIndex;
}

export { init, getPageNotes, loadPageNotes, getCurrentPageIndex };
