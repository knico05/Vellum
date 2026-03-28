/**
 * panel.js — Right panel: page overview + per-page notes
 *
 * Top section: scrollable page overview
 *   - Shows all pages (PDF + blank) in document order from pageManager
 *   - Click a card → viewport centres on that page
 *   - Blank pages show a delete button on hover; PDF pages do not
 *   - "+" button in header adds a new blank page after the current page
 *   - Active card (page nearest the viewport centre) is highlighted
 *
 * Bottom section: per-page notes textarea
 *   - Works for ALL pages (PDF and blank), keyed by pageId string
 *   - Saved in annotations JSON under "pageNotes"
 *
 * Exports: init(), getPageNotes(), loadPageNotes(), getCurrentPageId(), togglePanel()
 *
 * Page overview features:
 *   - Async thumbnail rendering via PDF.js (_renderThumbnails)
 *   - Jump-to-page input (keydown Enter → goToPageIndex)
 */

'use strict';

import { getPageList, addBlankPage, removePage, getCurrentPageId, goToPage,
         goToPageIndex, getPageCount, getPdfDoc }
  from '../pages/pageManager.js';
import { requestRender } from '../canvas/renderer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 800;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Per-page notes keyed by pageId (string). Saved to disk via getPageNotes(). */
const pageNotes = new Map();

/** pageId of the page currently shown in the notes textarea, or null */
let currentPageId = null;

/** Debounce timer for flushing textarea content to pageNotes */
let saveTimer = null;

/** DOM references */
let listEl      = null;
let textareaEl  = null;
let pageLabelEl = null;
let emptyMsgEl  = null;
let jumpInput   = null;

/**
 * Comma-joined list of page IDs from the last full DOM build.
 * Used to skip expensive DOM rebuilds when only ink/notes changed.
 */
let lastPageListKey = '';

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Builds the panel UI and attaches event listeners.
 * Must be called once after the DOM is ready.
 */
function init() {
  const panel = document.getElementById('notes-panel');
  if (!panel) return;

  panel.innerHTML = '';

  // ── Pages header ──────────────────────────────────────────────────────────
  const pagesHeader = document.createElement('div');
  pagesHeader.className = 'panel-pages-header';

  const pagesTitle = document.createElement('span');
  pagesTitle.className   = 'panel-pages-title';
  pagesTitle.textContent = 'Pages';

  const addBtn = document.createElement('button');
  addBtn.className = 'panel-add-page-btn';
  addBtn.title     = 'Add blank page';
  addBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
    <path d="M6.5 1v11M1 6.5h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
  addBtn.addEventListener('click', addBlankPage);

  pagesHeader.appendChild(pagesTitle);
  pagesHeader.appendChild(addBtn);
  panel.appendChild(pagesHeader);

  // ── Jump-to-page row ──────────────────────────────────────────────────────
  const jumpRow = document.createElement('div');
  jumpRow.className = 'panel-jump-row';

  const jumpLabel = document.createElement('span');
  jumpLabel.className   = 'panel-jump-label';
  jumpLabel.textContent = 'Go to page';

  jumpInput = document.createElement('input');
  jumpInput.type        = 'number';
  jumpInput.className   = 'panel-jump-input';
  jumpInput.min         = '1';
  jumpInput.placeholder = '#';
  jumpInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const n = parseInt(jumpInput.value, 10);
    if (isNaN(n)) return;
    goToPageIndex(Math.max(0, Math.min(getPageCount() - 1, n - 1)));
    requestRender();
    document.getElementById('canvas-container')
      ?.dispatchEvent(new CustomEvent('viewport-changed'));
    jumpInput.blur();
    jumpInput.value = '';
  });

  jumpRow.appendChild(jumpLabel);
  jumpRow.appendChild(jumpInput);
  panel.appendChild(jumpRow);

  // ── Page list ─────────────────────────────────────────────────────────────
  listEl = document.createElement('div');
  listEl.className = 'page-overview-list';
  panel.appendChild(listEl);

  // ── Divider ───────────────────────────────────────────────────────────────
  const sep = document.createElement('div');
  sep.className = 'panel-sep';
  panel.appendChild(sep);

  // ── Notes section ─────────────────────────────────────────────────────────
  const notesSection = document.createElement('div');
  notesSection.className = 'panel-notes-section';

  pageLabelEl = document.createElement('div');
  pageLabelEl.className = 'panel-page-label';

  textareaEl = document.createElement('textarea');
  textareaEl.className   = 'panel-textarea';
  textareaEl.placeholder = 'Notes for this page…';
  textareaEl.spellcheck  = true;

  emptyMsgEl = document.createElement('div');
  emptyMsgEl.className   = 'panel-empty';
  emptyMsgEl.textContent = 'Open a PDF to take notes.';

  notesSection.appendChild(pageLabelEl);
  notesSection.appendChild(textareaEl);
  notesSection.appendChild(emptyMsgEl);
  panel.appendChild(notesSection);

  showEmptyState();

  // Debounced note save
  textareaEl.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushCurrentNote, DEBOUNCE_MS);
  });

  // Structural page changes (add/remove blank pages) → full list rebuild
  document.addEventListener('pages-changed', rebuildList);

  // Annotation/viewport changes → only update active-card highlighting
  document.addEventListener('annotations-changed', updateActiveCard);
  document.getElementById('canvas-container')?.addEventListener('viewport-changed', () => {
    updateCurrentPage();
    updateActiveCard();
  });

  // Toggle button in toolbar
  document.getElementById('btn-toggle-panel')?.addEventListener('click', togglePanel);

  _restorePanelState();
  rebuildList();
}

// ---------------------------------------------------------------------------
// Page list
// ---------------------------------------------------------------------------

/**
 * Rebuilds the full page list DOM from scratch.
 * Only called when the page structure changes ('pages-changed' event).
 * Skips if the page IDs haven't changed since the last build.
 */
function rebuildList() {
  if (!listEl) return;

  const allPages = getPageList();

  // Skip full DOM rebuild if the page structure hasn't changed
  const newKey = allPages.map(p => p.id).join(',');
  if (newKey === lastPageListKey) {
    updateActiveCard();
    return;
  }
  lastPageListKey = newKey;

  if (allPages.length === 0) {
    listEl.innerHTML = '<div class="page-overview-empty">No pages yet.<br>Open a PDF or tap + to add a blank page.</div>';
    return;
  }

  listEl.innerHTML = '';

  // Update jump input's max to match current page count
  if (jumpInput) jumpInput.max = String(allPages.length);

  const THUMB_H = 56; // px — tall enough for readable content

  allPages.forEach((page, idx) => {
    const card = document.createElement('div');
    card.className  = 'page-card';
    card.dataset.id = page.id;

    // Thumbnail — proportionally sized, contains a canvas for the page preview
    const aspectRatio = page.width / page.height;
    const thumbW      = Math.round(Math.min(THUMB_H * aspectRatio, 60));

    const thumb = document.createElement('div');
    thumb.className = `page-card-thumb${page.kind === 'blank' ? ' page-card-thumb-blank' : ''}`;
    thumb.style.width  = `${thumbW}px`;
    thumb.style.height = `${THUMB_H}px`;

    // Canvas for rendered page preview (2× for sharpness on retina displays)
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.className = 'page-thumb-canvas';
    thumbCanvas.width     = thumbW * 2;
    thumbCanvas.height    = THUMB_H * 2;
    thumb.appendChild(thumbCanvas);

    // Page number badge — overlaid in the bottom-right corner
    const numEl = document.createElement('span');
    numEl.className   = 'page-card-number';
    numEl.textContent = String(idx + 1);
    thumb.appendChild(numEl);

    // Info
    const info = document.createElement('div');
    info.className = 'page-card-info';

    const labelEl = document.createElement('span');
    labelEl.className   = 'page-card-label';
    labelEl.textContent = page.kind === 'blank' ? 'Blank page' : `Page ${idx + 1}`;
    info.appendChild(labelEl);

    card.appendChild(thumb);
    card.appendChild(info);

    // Delete button — blank pages only
    if (page.kind === 'blank') {
      const delBtn = document.createElement('button');
      delBtn.className = 'page-card-delete';
      delBtn.title     = 'Delete page';
      delBtn.innerHTML = `<svg width="9" height="9" viewBox="0 0 9 9" fill="none">
        <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>`;
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removePage(page.id);
      });
      card.appendChild(delBtn);
    }

    // Navigate to page on click
    card.addEventListener('click', () => {
      goToPage(page.id);
      requestRender();
      document.getElementById('canvas-container')
        ?.dispatchEvent(new CustomEvent('viewport-changed'));
    });

    listEl.appendChild(card);
  });

  updateActiveCard();

  // Render page previews asynchronously so they don't delay the list paint
  _renderThumbnails(allPages);
}

/**
 * Renders page-preview thumbnails into each card's <canvas> element.
 * Runs asynchronously so it doesn't block the initial list paint.
 *
 * PDF pages are rendered via PDF.js at a scale that fills the canvas height.
 * Blank pages get a solid white fill.
 * Each canvas is 2× its CSS size for sharpness on high-DPI screens.
 *
 * @param {Array} pages — The full page list from getPageList()
 */
async function _renderThumbnails(pages) {
  if (!listEl) return;
  const pdfDoc = getPdfDoc();

  for (const page of pages) {
    const cardEl = listEl.querySelector(`[data-id="${page.id}"]`);
    if (!cardEl) continue; // list was rebuilt before we finished — stop

    const canvas = cardEl.querySelector('.page-thumb-canvas');
    if (!canvas) continue;
    const ctx = canvas.getContext('2d');

    if (page.kind === 'blank') {
      ctx.fillStyle = '#f5f5f5';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else if (pdfDoc) {
      try {
        // canvas.height is already 2× the CSS height for retina sharpness
        const renderScale = canvas.height / page.height;
        const pdfPage     = await pdfDoc.getPage(page.pdfPageIndex + 1);
        const vp          = pdfPage.getViewport({ scale: renderScale });
        await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
      } catch (err) {
        // Leave as grey placeholder if rendering fails (e.g. encrypted PDF)
        console.warn(`Thumbnail failed for page ${page.pdfPageIndex}:`, err.message);
      }
    }
  }
}

/**
 * Marks the card nearest the viewport centre as active.
 * Scrolls the active card into view.
 */
function updateActiveCard() {
  if (!listEl) return;

  const activeId = getCurrentPageId();

  for (const card of listEl.querySelectorAll('.page-card')) {
    const isActive = card.dataset.id === activeId;
    card.classList.toggle('active', isActive);
    if (isActive) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// ---------------------------------------------------------------------------
// Current-page detection (for the notes textarea)
// ---------------------------------------------------------------------------

/**
 * Updates currentPageId to the page nearest the viewport centre.
 * Works for all page kinds — both PDF and blank pages support notes.
 */
function updateCurrentPage() {
  const allPages = getPageList();

  if (allPages.length === 0) {
    currentPageId = null;
    showEmptyState();
    return;
  }

  const newPageId = getCurrentPageId();

  if (newPageId !== currentPageId) {
    flushCurrentNote();
    currentPageId = newPageId;
    loadCurrentPageIntoUI();
  }
}

// ---------------------------------------------------------------------------
// Notes UI helpers
// ---------------------------------------------------------------------------

function loadCurrentPageIntoUI() {
  if (currentPageId === null) {
    showEmptyState();
    return;
  }

  const allPages = getPageList();
  const page     = allPages.find(p => p.id === currentPageId);
  const listIdx  = allPages.indexOf(page);
  const label    = page
    ? (page.kind === 'blank' ? `Blank page ${listIdx + 1}` : `Page ${listIdx + 1}`)
    : '';

  if (textareaEl)  textareaEl.style.display  = '';
  if (emptyMsgEl)  emptyMsgEl.style.display  = 'none';
  if (pageLabelEl) pageLabelEl.textContent   = label;
  if (textareaEl)  textareaEl.value          = pageNotes.get(currentPageId) ?? '';
}

function showEmptyState() {
  if (textareaEl)  textareaEl.style.display  = 'none';
  if (emptyMsgEl)  emptyMsgEl.style.display  = '';
  if (pageLabelEl) pageLabelEl.textContent   = '';
}

function flushCurrentNote() {
  clearTimeout(saveTimer);
  saveTimer = null;

  if (currentPageId === null || !textareaEl) return;

  const text     = textareaEl.value;
  const previous = pageNotes.get(currentPageId) ?? '';

  if (text === previous) return;

  if (text.trim() === '') {
    pageNotes.delete(currentPageId);
  } else {
    pageNotes.set(currentPageId, text);
  }

  // 'notes-changed' (not 'annotations-changed') so the page list doesn't rebuild
  document.dispatchEvent(new CustomEvent('notes-changed'));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns all page notes as a plain object for serialisation by autosave.js.
 * Keys are pageId strings.
 *
 * @returns {{ [pageId: string]: string }}
 */
function getPageNotes() {
  const obj = {};
  for (const [id, text] of pageNotes) {
    if (text && text.trim() !== '') obj[id] = text;
  }
  return obj;
}

/**
 * Restores page notes from a parsed annotation file.
 * Accepts both v2 keys (pageId strings) and v1 keys (integer strings "0", "1"…)
 * — v1 keys are converted to "pdf-N" format for backward compatibility.
 *
 * @param {{ [key: string]: string }} notesObj
 */
function loadPageNotes(notesObj) {
  pageNotes.clear();

  if (!notesObj || typeof notesObj !== 'object') return;

  for (const [key, text] of Object.entries(notesObj)) {
    if (!text || typeof text !== 'string') continue;
    // v1 keys are plain integers ("0", "1"); convert to pageId format
    const pageId = /^\d+$/.test(key) ? `pdf-${key}` : key;
    pageNotes.set(pageId, text);
  }

  if (currentPageId !== null) loadCurrentPageIntoUI();
}

/**
 * Returns the 0-based list index of the currently visible page, or null.
 * Used by app.js to update the toolbar page indicator.
 * Returns a number (not a pageId) to remain compatible with toolbar.js's
 * `currentPage + 1` display logic.
 *
 * @returns {number|null}
 */
function getCurrentPageListIndexFromPanel() {
  if (currentPageId === null) return null;
  const allPages = getPageList();
  const idx      = allPages.findIndex(p => p.id === currentPageId);
  return idx === -1 ? null : idx;
}

// ---------------------------------------------------------------------------
// Panel visibility toggle
// ---------------------------------------------------------------------------

const PANEL_STORAGE_KEY = 'quicknotes-panel-open';

/**
 * Toggles the right panel open/closed.
 * State persists in localStorage so it survives app restarts.
 */
function togglePanel() {
  const main    = document.getElementById('main');
  const btn     = document.getElementById('btn-toggle-panel');
  const hidden  = main.classList.toggle('panel-hidden');

  btn?.classList.toggle('active', !hidden);
  localStorage.setItem(PANEL_STORAGE_KEY, hidden ? '0' : '1');
}

/**
 * Restores panel visibility from localStorage.
 * Called once during init().
 */
function _restorePanelState() {
  // Default: open (stored as '1' or absent)
  const stored = localStorage.getItem(PANEL_STORAGE_KEY);
  if (stored === '0') {
    document.getElementById('main')?.classList.add('panel-hidden');
  } else {
    document.getElementById('btn-toggle-panel')?.classList.add('active');
  }
}

export { init, getPageNotes, loadPageNotes, getCurrentPageListIndexFromPanel as getCurrentPageIndex, togglePanel };
