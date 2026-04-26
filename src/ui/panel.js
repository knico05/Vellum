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

import { getPageList, addBlankPage, removePage, movePage, getCurrentPageId, goToPage,
         goToPageIndex, getPageCount, getPdfDoc, pairPages, unpairPages, getPairedPartner }
  from '../pages/pageManager.js';
import { requestRender } from '../canvas/renderer.js';
import { showSearch, showSearchWithQuery } from './search.js';

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
let listEl        = null;
let textareaEl    = null;
let pageLabelEl   = null;
let emptyMsgEl    = null;
let jumpInput     = null;
let searchInputEl = null;

/**
 * Comma-joined list of page IDs from the last full DOM build.
 * Used to skip expensive DOM rebuilds when only ink/notes changed.
 */
let lastPageListKey = '';

/** Drag-to-reorder state for the page overview */
let dragFromIdx  = -1;
let dragOverIdx  = -1;
let dragPointerY = 0;

/** Template picker popup element (one at a time) */
let templatePickerEl = null;

/**
 * ID of the page whose link button was clicked first in a pairing gesture.
 * While set, the next link-button click pairs that page with the clicked one.
 */
let _pairingSourceId = null;

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
  addBtn.addEventListener('click', () => showTemplatePickerAt(addBtn, addBlankPage));

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

  // ── PDF text search ───────────────────────────────────────────────────────
  // In tablet mode Ctrl+F is inaccessible. This row provides a tap-friendly
  // alternative: type a query and press Enter (or tap the magnifying-glass button)
  // to open the floating PDF text search bar with that text pre-filled.
  const searchRow = document.createElement('div');
  searchRow.className = 'panel-search-row';

  searchInputEl = document.createElement('input');
  searchInputEl.type         = 'search';
  searchInputEl.className    = 'panel-search-input';
  searchInputEl.placeholder  = 'Search PDF…';
  searchInputEl.autocomplete = 'off';
  searchInputEl.spellcheck   = false;
  searchInputEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      searchInputEl.value = '';
      searchInputEl.blur();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = searchInputEl.value.trim();
      if (q) showSearchWithQuery(q);
      else   showSearch();
    }
  });

  const pdfSearchBtn = document.createElement('button');
  pdfSearchBtn.className = 'panel-pdf-search-btn';
  pdfSearchBtn.title     = 'Search PDF text';
  pdfSearchBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.5"/>
    <line x1="12.5" y1="12.5" x2="17" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
  pdfSearchBtn.addEventListener('click', () => {
    const q = searchInputEl.value.trim();
    if (q) showSearchWithQuery(q);
    else   showSearch();
  });

  searchRow.appendChild(searchInputEl);
  searchRow.appendChild(pdfSearchBtn);
  panel.appendChild(searchRow);

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
  // Pairing changes: page IDs don't change so force a full DOM rebuild
  document.addEventListener('paired-pages-changed', () => { lastPageListKey = ''; rebuildList(); });

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

    // Drag grip — touch-action:none so pointer capture works on tablet
    const grip = document.createElement('div');
    grip.className = 'page-card-grip';
    grip.title     = 'Drag to reorder';
    grip.innerHTML = `<svg width="10" height="14" viewBox="0 0 10 14" fill="none">
      <circle cx="3" cy="2"  r="1.5" fill="currentColor"/>
      <circle cx="7" cy="2"  r="1.5" fill="currentColor"/>
      <circle cx="3" cy="7"  r="1.5" fill="currentColor"/>
      <circle cx="7" cy="7"  r="1.5" fill="currentColor"/>
      <circle cx="3" cy="12" r="1.5" fill="currentColor"/>
      <circle cx="7" cy="12" r="1.5" fill="currentColor"/>
    </svg>`;
    grip.addEventListener('pointerdown', (e) => _startDrag(e, idx));
    card.appendChild(grip);

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

    // Pair link button — all pages
    const isPaired   = getPairedPartner(page.id) !== null;
    const linkBtn    = document.createElement('button');
    linkBtn.className = `page-card-link${isPaired ? ' paired' : ''}`;
    linkBtn.title     = isPaired ? 'Unpair pages' : 'Pair with another page (side-by-side)';
    linkBtn.innerHTML = isPaired
      ? `<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
           <path d="M6 8a2.5 2.5 0 0 0 3.5.5l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
           <path d="M10 8a2.5 2.5 0 0 0-3.5-.5l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
           <line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
         </svg>`
      : `<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
           <path d="M6 8a2.5 2.5 0 0 0 3.5.5l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
           <path d="M10 8a2.5 2.5 0 0 0-3.5-.5l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
         </svg>`;

    linkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isPaired) {
        // Already paired — clicking unpairs
        unpairPages(page.id);
        _pairingSourceId = null;
      } else if (_pairingSourceId === null) {
        // First click — enter pairing mode; highlight this card
        _pairingSourceId = page.id;
        lastPageListKey = ''; // force full DOM rebuild to show highlight
        rebuildList();
      } else if (_pairingSourceId === page.id) {
        // Clicked same card again — cancel pairing mode
        _pairingSourceId = null;
        lastPageListKey = '';
        rebuildList();
      } else {
        // Second click — pair the two pages
        pairPages(_pairingSourceId, page.id);
        _pairingSourceId = null;
        // pairPages() dispatches paired-pages-changed which triggers rebuildList()
      }
    });

    if (_pairingSourceId === page.id) {
      card.classList.add('pairing-source');
    }

    card.appendChild(linkBtn);

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
 * Renders page-preview thumbnails — visible cards first, then the rest in
 * batches of 5 with a setTimeout yield between batches to stay responsive
 * on large (200+ page) PDFs.
 *
 * @param {Array} pages — The full page list from getPageList()
 */
async function _renderThumbnails(pages) {
  if (!listEl) return;
  const pdfDoc = getPdfDoc();

  // Split into visible-first and deferred lists
  const listRect = listEl.getBoundingClientRect();
  const visible  = [];
  const deferred = [];

  for (const page of pages) {
    const cardEl = listEl.querySelector(`[data-id="${page.id}"]`);
    if (!cardEl) continue;
    const rect = cardEl.getBoundingClientRect();
    if (rect.bottom > listRect.top && rect.top < listRect.bottom) {
      visible.push(page);
    } else {
      deferred.push(page);
    }
  }

  // Render visible thumbnails immediately (parallel within this batch)
  await _renderBatch(visible, pdfDoc);

  // Render the rest in batches of 5, yielding between each batch
  const BATCH = 5;
  for (let i = 0; i < deferred.length; i += BATCH) {
    if (!listEl) return; // list was rebuilt — abort
    await _renderBatch(deferred.slice(i, i + BATCH), pdfDoc);
    await new Promise(r => setTimeout(r, 0));
  }
}

/**
 * Renders a batch of thumbnails in parallel.
 *
 * @param {Array} pages
 * @param {import('pdfjs-dist').PDFDocumentProxy|null} pdfDoc
 */
async function _renderBatch(pages, pdfDoc) {
  await Promise.all(pages.map(page => _renderOneThumbnail(page, pdfDoc)));
}

/**
 * Renders a single thumbnail into its card's <canvas>.
 *
 * @param {object} page
 * @param {import('pdfjs-dist').PDFDocumentProxy|null} pdfDoc
 */
async function _renderOneThumbnail(page, pdfDoc) {
  if (!listEl) return;
  const cardEl = listEl.querySelector(`[data-id="${page.id}"]`);
  if (!cardEl) return;
  const canvas = cardEl.querySelector('.page-thumb-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  if (page.kind === 'blank') {
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else if (pdfDoc) {
    try {
      const renderScale = canvas.height / page.height;
      const pdfPage     = await pdfDoc.getPage(page.pdfPageIndex + 1);
      const vp          = pdfPage.getViewport({ scale: renderScale });
      await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
    } catch (err) {
      console.warn(`Thumbnail failed for page ${page.pdfPageIndex}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Drag-to-reorder
// ---------------------------------------------------------------------------

/**
 * Begins a drag-reorder gesture from the grip handle of the card at fromIdx.
 * Uses setPointerCapture so all subsequent pointer events route to the grip
 * element — essential for reliable drag on tablet when the pointer exits the grip.
 *
 * @param {PointerEvent} e
 * @param {number} fromIdx
 */
function _startDrag(e, fromIdx) {
  e.preventDefault();
  e.stopPropagation();

  dragFromIdx  = fromIdx;
  dragOverIdx  = -1;
  dragPointerY = e.clientY;

  e.currentTarget.setPointerCapture(e.pointerId);
  e.currentTarget.addEventListener('pointermove',   _onDragMove);
  e.currentTarget.addEventListener('pointerup',     _onDragEnd);
  e.currentTarget.addEventListener('pointercancel', _onDragCancel);

  // Dim the card being dragged
  listEl.querySelectorAll('.page-card')[fromIdx]?.classList.add('dragging');
}

function _onDragMove(e) {
  dragPointerY = e.clientY;
  _updateDragTarget();
}

function _onDragEnd(e) {
  if (dragFromIdx !== -1 && dragOverIdx !== -1 && dragFromIdx !== dragOverIdx) {
    movePage(dragFromIdx, dragOverIdx);
  }
  _cleanupDrag(e.currentTarget);
}

function _onDragCancel(e) {
  _cleanupDrag(e.currentTarget);
}

function _cleanupDrag(grip) {
  grip.removeEventListener('pointermove',   _onDragMove);
  grip.removeEventListener('pointerup',     _onDragEnd);
  grip.removeEventListener('pointercancel', _onDragCancel);

  listEl?.querySelectorAll('.page-card.dragging').forEach(c => c.classList.remove('dragging'));
  listEl?.querySelectorAll('.drop-indicator').forEach(el => el.remove());

  dragFromIdx = -1;
  dragOverIdx = -1;
}

/**
 * Finds the closest card to the pointer and updates the drop indicator.
 * "Closest" = card whose vertical centre is nearest dragPointerY,
 * excluding the card being dragged.
 */
function _updateDragTarget() {
  if (!listEl || dragFromIdx === -1) return;

  const cards = [...listEl.querySelectorAll('.page-card')];
  let closest     = -1;
  let closestDist = Infinity;

  for (let i = 0; i < cards.length; i++) {
    if (i === dragFromIdx) continue;
    const rect   = cards[i].getBoundingClientRect();
    const centre = rect.top + rect.height / 2;
    const dist   = Math.abs(dragPointerY - centre);
    if (dist < closestDist) { closestDist = dist; closest = i; }
  }

  if (closest === dragOverIdx) return;
  dragOverIdx = closest;

  // Reposition the drop indicator
  listEl.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  if (dragOverIdx === -1) return;

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  // Indicator goes above the target if dragging up, below if dragging down
  if (dragOverIdx < dragFromIdx) {
    cards[dragOverIdx].insertAdjacentElement('beforebegin', indicator);
  } else {
    cards[dragOverIdx].insertAdjacentElement('afterend', indicator);
  }
}

// ---------------------------------------------------------------------------
// Template picker
// ---------------------------------------------------------------------------

const TEMPLATES = [
  { id: 'plain',   label: 'Plain'   },
  { id: 'lined',   label: 'Lined'   },
  { id: 'dotted',  label: 'Dotted'  },
  { id: 'graph',   label: 'Graph'   },
  { id: 'cornell', label: 'Cornell' },
];

const GRID_SIZES = [
  { value: 16, label: 'S' },
  { value: 24, label: 'M' },
  { value: 40, label: 'L' },
];

/** Last chosen grid size, persisted across picker opens */
let _pickerGridSize = 24;

/**
 * Shows a template-picker popup anchored below (or above) anchorEl.
 * Calls onSelect(templateId, gridSize) when the user taps an option, then closes.
 *
 * @param {HTMLElement} anchorEl
 * @param {function(string, number): void} onSelect
 */
function showTemplatePickerAt(anchorEl, onSelect) {
  _closeTemplatePicker();

  templatePickerEl = document.createElement('div');
  templatePickerEl.className = 'template-picker';

  // Template row
  const templateRow = document.createElement('div');
  templateRow.className = 'template-picker-row';

  for (const tpl of TEMPLATES) {
    const btn = document.createElement('button');
    btn.className = 'template-picker-btn';

    const preview = document.createElement('div');
    preview.className = `template-preview template-preview-${tpl.id}`;

    const label = document.createElement('span');
    label.className   = 'template-picker-label';
    label.textContent = tpl.label;

    btn.appendChild(preview);
    btn.appendChild(label);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSelect(tpl.id, _pickerGridSize);
      _closeTemplatePicker();
    });

    templateRow.appendChild(btn);
  }

  templatePickerEl.appendChild(templateRow);

  // Grid size row (only relevant for lined / dotted / graph)
  const sizeRow = document.createElement('div');
  sizeRow.className = 'template-picker-size-row';

  const sizeLabel = document.createElement('span');
  sizeLabel.className   = 'template-picker-size-label';
  sizeLabel.textContent = 'Grid size:';
  sizeRow.appendChild(sizeLabel);

  for (const gs of GRID_SIZES) {
    const btn = document.createElement('button');
    btn.className = 'template-size-btn';
    btn.textContent = gs.label;
    btn.title = `Grid spacing ${gs.value} units`;
    btn.classList.toggle('active', gs.value === _pickerGridSize);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _pickerGridSize = gs.value;
      for (const b of sizeRow.querySelectorAll('.template-size-btn')) {
        b.classList.toggle('active', b.textContent === gs.label);
      }
    });
    sizeRow.appendChild(btn);
  }

  templatePickerEl.appendChild(sizeRow);

  document.body.appendChild(templatePickerEl);

  // Position: below the anchor by default, above if there's not enough space
  const rect    = anchorEl.getBoundingClientRect();
  const pickerW = templatePickerEl.offsetWidth  || 340;
  const pickerH = templatePickerEl.offsetHeight || 110;

  let left = rect.left;
  let top  = rect.bottom + 6;

  if (left + pickerW > window.innerWidth  - 8) left = window.innerWidth  - pickerW - 8;
  if (top  + pickerH > window.innerHeight - 8) top  = rect.top - pickerH - 6;

  templatePickerEl.style.left = `${Math.max(8, left)}px`;
  templatePickerEl.style.top  = `${Math.max(8, top)}px`;

  // Close on any tap outside the picker
  setTimeout(() => {
    document.addEventListener('pointerdown', _closePickerOnOutside, { capture: true });
  }, 0);
}

function _closePickerOnOutside(e) {
  if (templatePickerEl && !templatePickerEl.contains(e.target)) {
    _closeTemplatePicker();
  }
}

function _closeTemplatePicker() {
  templatePickerEl?.remove();
  templatePickerEl = null;
  document.removeEventListener('pointerdown', _closePickerOnOutside, { capture: true });
}

/**
 * Convenience wrapper used by app.js for the toolbar "New Page" button.
 * Shows the template picker anchored to the given element.
 *
 * @param {HTMLElement} anchorEl
 */
function addBlankPageWithPicker(anchorEl) {
  showTemplatePickerAt(anchorEl, addBlankPage);
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

export { init, getPageNotes, loadPageNotes, getCurrentPageListIndexFromPanel as getCurrentPageIndex, togglePanel, addBlankPageWithPicker };
