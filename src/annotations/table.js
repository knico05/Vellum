/**
 * table.js — Table annotation tool (DOM overlay approach)
 *
 * Tables are <div> wrappers containing a <table> element, absolutely positioned
 * inside #canvas-container. They pan and zoom with the viewport via CSS transform,
 * following the same pattern as note.js (text boxes).
 *
 * Lifecycle:
 *   - T tool active → single click places a 3×4 table
 *   - annotations-changed event → syncElements() creates/removes DOM nodes
 *   - register() callback → updatePositions() repositions all tables each frame
 *   - Drag the top strip → updates canvasX/canvasY in manager
 *   - Click × button → removes annotation
 *   - Right-click inside table → context menu: add/remove row/column
 *   - Resize handle → updates width/height in manager
 *
 * Annotation schema:
 *   type    {string}   — 'table'
 *   pageId  {string}   — page identifier
 *   canvasX {number}   — canvas-space x position
 *   canvasY {number}   — canvas-space y position
 *   width   {number}   — canvas-space width
 *   height  {number}   — canvas-space height (auto if not resized)
 *   rows    {number}   — row count
 *   cols    {number}   — column count
 *   data    {string[][]} — 2D array of cell text [row][col]
 *
 * Exports: initTables(), activateTable(), deactivateTable()
 */

'use strict';

import { toCanvas, toScreen, state as viewportState } from '../canvas/viewport.js';
import { register, requestRender }                    from '../canvas/renderer.js';
import { add, update, remove, getAll }                from './manager.js';
import { resolvePageId }                              from '../pages/pageManager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ROWS = 3;
const DEFAULT_COLS = 4;

// ---------------------------------------------------------------------------
// Pending placement dimensions (set by toolbar config inputs)
// ---------------------------------------------------------------------------

let pendingRows = DEFAULT_ROWS;
let pendingCols = DEFAULT_COLS;

/**
 * Called by toolbar.js when the user changes the row/col inputs.
 * Applied to the next table that is placed.
 *
 * @param {number} rows
 * @param {number} cols
 */
function setTableDimensions(rows, cols) {
  pendingRows = rows;
  pendingCols = cols;
}

const DEFAULT_WIDTH  = 320;
const DEFAULT_HEIGHT = 120;

const MIN_WIDTH  = 120;
const MIN_HEIGHT = 60;

const SAVE_DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let container   = null;
let toolActive  = false;

/** Map of annotation id → wrapper DOM element */
const tableElements = new Map();

/** Map of annotation id → pending save timer */
const saveTimers = new Map();

/** Active drag state or null */
let dragState = null;

/** Active resize state or null */
let resizeState = null;

/** The floating context menu element (singleton) */
let contextMenu = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function init() {
  container = document.getElementById('canvas-container');

  container.addEventListener('click', onCanvasClick);

  document.addEventListener('annotations-changed', (e) => {
    syncElements(e?.detail?.fromLoad ?? false);
  });

  register(updatePositions);
  buildContextMenu();
}

function activate() {
  toolActive = true;
  container.classList.add('tool-table');
}

function deactivate() {
  toolActive = false;
  container.classList.remove('tool-table');
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

function onCanvasClick(e) {
  if (!toolActive) return;
  if (e.target.closest('.annotation-table')) return;
  const rect     = container.getBoundingClientRect();
  const { x, y } = toCanvas(e.clientX - rect.left, e.clientY - rect.top);
  placeTable(x, y);
  deactivate();
  document.dispatchEvent(new CustomEvent('table-placed'));
}

function placeTable(canvasX, canvasY) {
  const rows   = pendingRows;
  const cols   = pendingCols;
  // Scale default size to the number of columns so cells aren't tiny
  const width  = Math.max(DEFAULT_WIDTH,  cols * 80);
  const height = Math.max(DEFAULT_HEIGHT, rows * 32 + 8); // +8 for drag strip
  const data   = Array.from({ length: rows }, () => Array(cols).fill(''));
  add({
    type:    'table',
    pageId:  resolvePageId(canvasX, canvasY),
    canvasX,
    canvasY,
    width,
    height,
    rows,
    cols,
    data,
    title:   '',
  });
}

// ---------------------------------------------------------------------------
// DOM ↔ store synchronisation
// ---------------------------------------------------------------------------

function syncElements(fromLoad = false) {
  const annotations = getAll().filter(a => a.type === 'table');
  const currentIds  = new Set(annotations.map(a => a.id));

  for (const [id, el] of tableElements) {
    if (!currentIds.has(id)) {
      el.remove();
      tableElements.delete(id);
    }
  }

  for (const anno of annotations) {
    if (!tableElements.has(anno.id)) {
      const el = createTableElement(anno);
      container.appendChild(el);
      tableElements.set(anno.id, el);
    } else {
      syncTableDOM(tableElements.get(anno.id), anno);
    }
  }

  updatePositions();
  requestRender();
}

// ---------------------------------------------------------------------------
// Per-frame positioning
// ---------------------------------------------------------------------------

function updatePositions() {
  const byId = new Map(getAll().map(a => [a.id, a]));
  for (const [id, el] of tableElements) {
    const anno = byId.get(id);
    if (!anno) continue;
    const { x, y } = toScreen(anno.canvasX, anno.canvasY);
    el.style.transform = `translate(${x}px, ${y}px) scale(${viewportState.scale})`;
    const wPx = `${anno.width}px`;
    if (el.style.width !== wPx) el.style.width = wPx;
  }
}

// ---------------------------------------------------------------------------
// DOM element factory
// ---------------------------------------------------------------------------

function createTableElement(anno) {
  const el = document.createElement('div');
  el.className  = 'annotation-table';
  el.dataset.id = anno.id;
  el.style.cssText = [
    'position: absolute',
    'top: 0',
    'left: 0',
    'transform-origin: top left',
    `width: ${anno.width}px`,
    'z-index: 2',
  ].join('; ');

  // Drag strip (doubles as the title bar)
  const dragStrip = document.createElement('div');
  dragStrip.className = 'annotation-table-drag';

  // Editable table title inside the drag strip
  const titleEl = document.createElement('div');
  titleEl.className       = 'annotation-table-title';
  titleEl.contentEditable = 'true';
  titleEl.textContent     = anno.title ?? '';
  titleEl.title           = 'Table name — click to edit';
  dragStrip.appendChild(titleEl);

  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className   = 'annotation-table-delete';
  deleteBtn.textContent = '×';
  deleteBtn.title       = 'Delete table';

  // Table element
  const tableEl = buildTableEl(anno);

  // Resize handle
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'annotation-table-resize';

  el.appendChild(dragStrip);
  el.appendChild(deleteBtn);
  el.appendChild(tableEl);
  el.appendChild(resizeHandle);

  // Event wiring
  // Dragging only starts on the drag strip itself, not on the title input
  dragStrip.addEventListener('pointerdown', (e) => {
    if (e.target === titleEl || titleEl.contains(e.target)) return;
    onDragStart(e, anno.id, dragStrip);
  });
  dragStrip.addEventListener('pointermove', onDragMove);
  dragStrip.addEventListener('pointerup',   (e) => onDragEnd(e, dragStrip));
  dragStrip.addEventListener('pointercancel', (e) => onDragEnd(e, dragStrip));

  // Save title on input (debounced with the same timer as cell content)
  titleEl.addEventListener('input', () => scheduleSave(anno.id));
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    e.stopPropagation();
  });

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearTimeout(saveTimers.get(anno.id));
    remove(anno.id);
  });

  resizeHandle.addEventListener('pointerdown',   (e) => onResizeStart(e, anno.id, resizeHandle));
  resizeHandle.addEventListener('pointermove',   onResizeMove);
  resizeHandle.addEventListener('pointerup',     (e) => onResizeEnd(e, resizeHandle));
  resizeHandle.addEventListener('pointercancel', (e) => onResizeEnd(e, resizeHandle));

  // Right-click inside the table → context menu
  tableEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, anno.id);
  });

  // Prevent canvas events from firing through the table
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') e.stopPropagation();
  });
  el.addEventListener('wheel', (e) => e.stopPropagation());

  return el;
}

/**
 * Builds or rebuilds the <table> element from the annotation data.
 */
function buildTableEl(anno) {
  const tableEl = document.createElement('table');
  tableEl.className = 'annotation-table-grid';

  for (let r = 0; r < anno.rows; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < anno.cols; c++) {
      const td = document.createElement('td');
      td.contentEditable = 'true';
      td.className       = 'annotation-table-cell';
      td.textContent     = anno.data?.[r]?.[c] ?? '';
      td.addEventListener('input', () => scheduleSave(anno.id));
      td.addEventListener('keydown', (e) => {
        // Tab moves to next cell
        if (e.key === 'Tab') {
          e.preventDefault();
          const cells = [...tableEl.querySelectorAll('td')];
          const idx   = cells.indexOf(td);
          const next  = cells[e.shiftKey ? idx - 1 : idx + 1];
          if (next) next.focus();
        }
        e.stopPropagation(); // don't fire canvas shortcuts while typing
      });
      tr.appendChild(td);
    }
    tableEl.appendChild(tr);
  }

  return tableEl;
}

/**
 * Re-synchronises the DOM table with the annotation's current data/size.
 * Rebuilds the table element entirely when rows/cols change.
 */
function syncTableDOM(el, anno) {
  // Sync title (skip if focused to avoid caret jump)
  const titleEl = el.querySelector('.annotation-table-title');
  if (titleEl && document.activeElement !== titleEl) {
    const t = anno.title ?? '';
    if (titleEl.textContent !== t) titleEl.textContent = t;
  }

  const existing = el.querySelector('.annotation-table-grid');
  const rows     = existing ? existing.querySelectorAll('tr').length    : 0;
  const cols     = existing ? existing.querySelector('tr')?.children.length ?? 0 : 0;

  if (rows !== anno.rows || cols !== anno.cols) {
    // Structure changed — rebuild
    existing?.remove();
    el.insertBefore(buildTableEl(anno), el.querySelector('.annotation-table-resize'));
  } else if (existing) {
    // Just update cell text (skip cells that are focused to avoid caret jump)
    existing.querySelectorAll('tr').forEach((tr, r) => {
      [...tr.children].forEach((td, c) => {
        if (document.activeElement !== td) {
          const val = anno.data?.[r]?.[c] ?? '';
          if (td.textContent !== val) td.textContent = val;
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Cell data persistence
// ---------------------------------------------------------------------------

function scheduleSave(annotationId) {
  clearTimeout(saveTimers.get(annotationId));
  const timer = setTimeout(() => {
    const el       = tableElements.get(annotationId);
    const tableEl  = el?.querySelector('.annotation-table-grid');
    if (!tableEl) return;

    const data  = [...tableEl.querySelectorAll('tr')].map(tr =>
      [...tr.querySelectorAll('td')].map(td => td.textContent)
    );
    const title = el.querySelector('.annotation-table-title')?.textContent ?? '';
    update(annotationId, { data, title });
    saveTimers.delete(annotationId);
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(annotationId, timer);
}

// ---------------------------------------------------------------------------
// Context menu (add/remove rows and columns)
// ---------------------------------------------------------------------------

function buildContextMenu() {
  contextMenu = document.createElement('div');
  contextMenu.className = 'table-context-menu hidden';
  document.body.appendChild(contextMenu);

  document.addEventListener('pointerdown', (e) => {
    if (!contextMenu.contains(e.target)) hideContextMenu();
  }, { capture: true });
}

function showContextMenu(clientX, clientY, annotationId) {
  contextMenu.innerHTML = '';

  const items = [
    { label: 'Add row above',    action: () => mutateTable(annotationId, 'addRowAbove') },
    { label: 'Add row below',    action: () => mutateTable(annotationId, 'addRowBelow') },
    { label: 'Add column left',  action: () => mutateTable(annotationId, 'addColLeft')  },
    { label: 'Add column right', action: () => mutateTable(annotationId, 'addColRight') },
    null, // separator
    { label: 'Delete row',    action: () => mutateTable(annotationId, 'deleteRow')    },
    { label: 'Delete column', action: () => mutateTable(annotationId, 'deleteCol')    },
    null,
    { label: 'Delete table', action: () => { remove(annotationId); }, danger: true },
  ];

  for (const item of items) {
    if (!item) {
      const sep = document.createElement('div');
      sep.className = 'table-context-sep';
      contextMenu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className   = 'table-context-item' + (item.danger ? ' danger' : '');
    btn.textContent = item.label;
    btn.addEventListener('click', () => { hideContextMenu(); item.action(); });
    contextMenu.appendChild(btn);
  }

  contextMenu.classList.remove('hidden');
  const x = Math.min(clientX, window.innerWidth  - contextMenu.offsetWidth  - 8);
  const y = Math.min(clientY, window.innerHeight - contextMenu.offsetHeight - 8);
  contextMenu.style.left = `${Math.max(0, x)}px`;
  contextMenu.style.top  = `${Math.max(0, y)}px`;
}

function hideContextMenu() {
  contextMenu?.classList.add('hidden');
}

/** Adds or removes rows/columns from an annotation. */
function mutateTable(annotationId, action) {
  const anno = getAll().find(a => a.id === annotationId);
  if (!anno) return;

  let { rows, cols, data } = anno;
  data = data.map(r => [...r]); // deep copy

  switch (action) {
    case 'addRowAbove': data.unshift(Array(cols).fill('')); rows++; break;
    case 'addRowBelow': data.push(Array(cols).fill(''));    rows++; break;
    case 'addColLeft':
      data = data.map(r => ['', ...r]); cols++; break;
    case 'addColRight':
      data = data.map(r => [...r, '']); cols++; break;
    case 'deleteRow':
      if (rows <= 1) return;
      data.pop(); rows--; break;
    case 'deleteCol':
      if (cols <= 1) return;
      data = data.map(r => r.slice(0, -1)); cols--; break;
  }

  update(annotationId, { rows, cols, data });
}

// ---------------------------------------------------------------------------
// Drag handlers
// ---------------------------------------------------------------------------

function onDragStart(e, annotationId, strip) {
  if (e.button !== 0) return;
  e.preventDefault();
  strip.setPointerCapture(e.pointerId);
  strip.style.cursor = 'grabbing';
  const anno = getAll().find(a => a.id === annotationId);
  dragState = {
    annotationId,
    startCanvasX: anno.canvasX,
    startCanvasY: anno.canvasY,
    startClientX: e.clientX,
    startClientY: e.clientY,
  };
}

function onDragMove(e) {
  if (!dragState) return;
  const scale = viewportState.scale;
  const dx    = (e.clientX - dragState.startClientX) / scale;
  const dy    = (e.clientY - dragState.startClientY) / scale;
  update(dragState.annotationId, {
    canvasX: dragState.startCanvasX + dx,
    canvasY: dragState.startCanvasY + dy,
  });
  requestRender();
}

function onDragEnd(e, strip) {
  if (!dragState) return;
  strip.releasePointerCapture(e.pointerId);
  strip.style.cursor = '';
  dragState = null;
}

// ---------------------------------------------------------------------------
// Resize handlers
// ---------------------------------------------------------------------------

function onResizeStart(e, annotationId, handle) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  handle.setPointerCapture(e.pointerId);
  const anno = getAll().find(a => a.id === annotationId);
  resizeState = { annotationId, canvasX: anno.canvasX, canvasY: anno.canvasY };
}

function onResizeMove(e) {
  if (!resizeState) return;
  const rect  = container.getBoundingClientRect();
  const { x } = toCanvas(e.clientX - rect.left, e.clientY - rect.top);
  update(resizeState.annotationId, {
    width: Math.max(MIN_WIDTH, x - resizeState.canvasX),
  });
  requestRender();
}

function onResizeEnd(e, handle) {
  if (!resizeState) return;
  handle.releasePointerCapture(e.pointerId);
  resizeState = null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initTables, activate as activateTable, deactivate as deactivateTable, setTableDimensions };
