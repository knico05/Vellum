/**
 * note.js — Text box annotation tool (DOM overlay approach)
 *
 * Text boxes are transparent <div> elements absolutely positioned inside
 * #canvas-container. They pan and zoom with the viewport via CSS transform.
 *
 * z-index: 2 — sits above the annotation canvas (z-index: 1) and PDF pages.
 *
 * Lifecycle:
 *   - Double-click on canvas → creates a new text box at that canvas position
 *   - annotations-changed event → syncElements() creates/removes DOM nodes
 *   - register() callback → updatePositions() repositions all boxes each frame
 *   - Drag the top drag strip → updates canvasX/canvasY in manager
 *   - Click × button → removes annotation from manager
 *   - Focus/blur body → shows/hides inline options bar (colour + size)
 *   - Type in body → debounced save to manager
 *
 * Annotation schema additions vs sticky note:
 *   colour   {string} — CSS hex colour for the text, default '#000000'
 *   fontSize {number} — font size in px (canvas units), default 14
 *
 * Exports: initNotes()
 */

'use strict';

import { toCanvas, toScreen, state as viewportState } from '../canvas/viewport.js';
import { register, requestRender }                    from '../canvas/renderer.js';
import { add, update, remove, getAll }                from './manager.js';
import { getPages }                                   from '../pdf/pdfManager.js';
import { getDragOffset }                              from './select.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOX_WIDTH  = 200;
const BOX_HEIGHT = 120;

const MIN_BOX_WIDTH  = 60;
const MIN_BOX_HEIGHT = 32;

const SAVE_DEBOUNCE_MS = 500;

const DEFAULT_COLOUR    = '#000000';
const DEFAULT_FONT_SIZE = 14;

/**
 * Colour options shown in the inline options bar.
 * Each entry is a CSS colour string.
 */
const COLOURS = [
  { value: '#000000', label: 'Black'      },
  { value: '#444444', label: 'Dark grey'  },
  { value: '#ffffff', label: 'White'      },
  { value: '#e53e3e', label: 'Red'        },
  { value: '#f0b429', label: 'Amber'      },
  { value: '#3b82f6', label: 'Blue'       },
  { value: '#10b981', label: 'Green'      },
];

/**
 * Font size presets shown in the inline options bar.
 */
const FONT_SIZES = [
  { label: 'S',  value: 11 },
  { label: 'M',  value: 14 },
  { label: 'L',  value: 18 },
  { label: 'XL', value: 24 },
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let container = null;

/** Map of annotation id → DOM element */
const boxElements = new Map();

/** Map of annotation id → pending save setTimeout handle */
const saveTimers = new Map();

/** Active drag state for the top drag strip, or null */
let dragState = null;

/** Active resize state for the bottom-right corner, or null */
let resizeState = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/** pointerType of the most recent pointerdown — used to filter dblclick by input device */
let lastPointerType = 'mouse';

function init() {
  container = document.getElementById('canvas-container');

  // Track which input device was last used so dblclick can filter by type
  container.addEventListener('pointerdown', (e) => { lastPointerType = e.pointerType; });

  container.addEventListener('dblclick', onCreate);

  document.addEventListener('annotations-changed', syncElements);
  register(updatePositions);
}

// ---------------------------------------------------------------------------
// Box creation
// ---------------------------------------------------------------------------

function onCreate(e) {
  // Text boxes are created by touch double-tap or mouse double-click only.
  // Pen double-tap should draw, not place a text box.
  if (lastPointerType === 'pen') return;
  if (e.target.closest('.text-box')) return;

  const rect     = container.getBoundingClientRect();
  const { x, y } = toCanvas(e.clientX - rect.left, e.clientY - rect.top);

  add({
    type:      'textBox',
    pageIndex: resolvePageIndex(x, y),
    canvasX:   x - BOX_WIDTH  / 2,
    canvasY:   y - BOX_HEIGHT / 2,
    width:     BOX_WIDTH,
    height:    BOX_HEIGHT,
    text:      '',
    colour:    DEFAULT_COLOUR,
    fontSize:  DEFAULT_FONT_SIZE,
  });
}

// ---------------------------------------------------------------------------
// DOM ↔ store synchronisation
// ---------------------------------------------------------------------------

function syncElements() {
  const annotations = getAll().filter(a => a.type === 'textBox');
  const currentIds  = new Set(annotations.map(a => a.id));

  for (const [id, el] of boxElements) {
    if (!currentIds.has(id)) {
      el.remove();
      boxElements.delete(id);
    }
  }

  for (const anno of annotations) {
    if (!boxElements.has(anno.id)) {
      const el = createBoxElement(anno);
      container.appendChild(el);
      boxElements.set(anno.id, el);

      requestAnimationFrame(() => {
        const body = el.querySelector('.text-box-body');
        if (body) body.focus();
      });
    } else {
      const el   = boxElements.get(anno.id);
      const body = el.querySelector('.text-box-body');
      if (body && document.activeElement !== body) {
        body.textContent = anno.text;
      }
      applyBodyStyle(el, anno);
      el.style.width  = `${anno.width}px`;
      el.style.height = `${anno.height}px`;
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

  for (const [id, el] of boxElements) {
    const anno = byId.get(id);
    if (!anno) continue;

    const offset   = getDragOffset(id);
    const displayX = anno.canvasX + (offset ? offset.dx : 0);
    const displayY = anno.canvasY + (offset ? offset.dy : 0);
    const { x, y } = toScreen(displayX, displayY);
    el.style.transform = `translate(${x}px, ${y}px) scale(${viewportState.scale})`;
  }
}

// ---------------------------------------------------------------------------
// DOM element factory
// ---------------------------------------------------------------------------

/**
 * Builds the DOM structure for one text box.
 *
 * Structure:
 *   <div class="text-box">
 *     <div class="text-box-drag"></div>
 *     <div class="text-box-options">   ← visible only when .editing
 *       colour swatches + size buttons
 *     </div>
 *     <button class="text-box-delete">×</button>
 *     <div class="text-box-body" contenteditable>…</div>
 *     <div class="text-box-resize"></div>
 *   </div>
 */
function createBoxElement(anno) {
  const el = document.createElement('div');
  el.className  = 'text-box';
  el.dataset.id = anno.id;
  el.style.cssText = [
    'position: absolute',
    'top: 0',
    'left: 0',
    'transform-origin: top left',
    `width: ${anno.width}px`,
    `height: ${anno.height}px`,
    'z-index: 2',
  ].join('; ');

  // ── Drag strip ────────────────────────────────────────────────────────────
  const dragStrip = document.createElement('div');
  dragStrip.className = 'text-box-drag';

  // ── Inline options bar (colour + size) ───────────────────────────────────
  const optionsBar = buildOptionsBar(anno);

  // ── Delete button ─────────────────────────────────────────────────────────
  const deleteBtn = document.createElement('button');
  deleteBtn.className   = 'text-box-delete';
  deleteBtn.textContent = '×';
  deleteBtn.title       = 'Delete';

  // ── Editable body ─────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className       = 'text-box-body';
  body.contentEditable = 'true';
  body.textContent     = anno.text;
  applyBodyStyle(el, anno); // set initial colour + font size

  // ── Resize handle ─────────────────────────────────────────────────────────
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'text-box-resize';

  el.appendChild(dragStrip);
  el.appendChild(optionsBar);
  el.appendChild(deleteBtn);
  el.appendChild(body);
  el.appendChild(resizeHandle);

  // ── Event wiring ──────────────────────────────────────────────────────────

  dragStrip.addEventListener('pointerdown', (e) => onDragStart(e, anno.id, dragStrip));
  dragStrip.addEventListener('pointermove',   onDragMove);
  dragStrip.addEventListener('pointerup',     (e) => onDragEnd(e, dragStrip));
  dragStrip.addEventListener('pointercancel', (e) => onDragEnd(e, dragStrip));

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearTimeout(saveTimers.get(anno.id));
    remove(anno.id);
  });

  resizeHandle.addEventListener('pointerdown',   (e) => onResizeStart(e, anno.id, resizeHandle));
  resizeHandle.addEventListener('pointermove',   onResizeMove);
  resizeHandle.addEventListener('pointerup',     (e) => onResizeEnd(e, resizeHandle));
  resizeHandle.addEventListener('pointercancel', (e) => onResizeEnd(e, resizeHandle));

  body.addEventListener('input', () => scheduleTextSave(anno.id, body));

  body.addEventListener('focus', () => el.classList.add('editing'));
  body.addEventListener('blur',  () => {
    // Delay removing .editing so clicks on the options bar don't close it
    // before the click event fires.
    setTimeout(() => {
      if (!el.contains(document.activeElement)) {
        el.classList.remove('editing');
      }
    }, 150);
  });

  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('wheel',       (e) => e.stopPropagation());

  return el;
}

// ---------------------------------------------------------------------------
// Inline options bar
// ---------------------------------------------------------------------------

/**
 * Builds the colour + size options bar for one text box.
 * Wires click handlers that update the annotation immediately.
 *
 * @param {object} anno
 * @returns {HTMLElement}
 */
function buildOptionsBar(anno) {
  const bar = document.createElement('div');
  bar.className = 'text-box-options';

  // Colour swatches
  for (const colour of COLOURS) {
    const swatch = document.createElement('button');
    swatch.className        = 'tbo-swatch';
    swatch.title            = colour.label;
    swatch.style.background = colour.value;
    // White swatch needs a border so it's visible on a light background
    if (colour.value === '#ffffff') {
      swatch.style.outline = '1px solid #ccc';
      swatch.style.outlineOffset = '-1px';
    }

    swatch.addEventListener('mousedown', (e) => {
      // mousedown instead of click so we can preventDefault and keep focus
      e.preventDefault();
      e.stopPropagation();
      update(anno.id, { colour: colour.value });
      // Refresh the body style immediately via the DOM (don't wait for
      // annotations-changed which would blur/deblur the contenteditable)
      const el   = boxElements.get(anno.id);
      const body = el?.querySelector('.text-box-body');
      if (body) body.style.color = colour.value;
      syncSwatchState(bar, colour.value);
      // Restore focus to the body
      body?.focus();
    });

    bar.appendChild(swatch);
  }

  // Separator
  const sep = document.createElement('div');
  sep.className = 'tbo-sep';
  bar.appendChild(sep);

  // Font size presets
  for (const size of FONT_SIZES) {
    const btn = document.createElement('button');
    btn.className   = 'tbo-size';
    btn.textContent = size.label;
    btn.title       = `${size.value}px`;
    btn.dataset.size = size.value;

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      update(anno.id, { fontSize: size.value });
      const el   = boxElements.get(anno.id);
      const body = el?.querySelector('.text-box-body');
      if (body) body.style.fontSize = `${size.value}px`;
      syncSizeState(bar, size.value);
      body?.focus();
    });

    bar.appendChild(btn);
  }

  // Set initial active states
  syncSwatchState(bar, anno.colour   ?? DEFAULT_COLOUR);
  syncSizeState(bar,   anno.fontSize ?? DEFAULT_FONT_SIZE);

  return bar;
}

/**
 * Marks the currently selected colour swatch as active.
 */
function syncSwatchState(bar, activeColour) {
  for (const swatch of bar.querySelectorAll('.tbo-swatch')) {
    const isActive = swatch.style.background === activeColour ||
                     swatch.style.backgroundColor === activeColour;
    swatch.classList.toggle('active', isActive);
  }
}

/**
 * Marks the currently selected size button as active.
 */
function syncSizeState(bar, activeSize) {
  for (const btn of bar.querySelectorAll('.tbo-size')) {
    btn.classList.toggle('active', Number(btn.dataset.size) === activeSize);
  }
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

/**
 * Applies the annotation's colour and fontSize to the body element.
 * Called during sync and on initial creation.
 *
 * @param {HTMLElement} boxEl
 * @param {object}      anno
 */
function applyBodyStyle(boxEl, anno) {
  const body = boxEl.querySelector('.text-box-body');
  if (!body) return;
  body.style.color    = anno.colour   ?? DEFAULT_COLOUR;
  body.style.fontSize = `${anno.fontSize ?? DEFAULT_FONT_SIZE}px`;
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

  const rect     = container.getBoundingClientRect();
  const { x, y } = toCanvas(e.clientX - rect.left, e.clientY - rect.top);

  update(resizeState.annotationId, {
    width:  Math.max(MIN_BOX_WIDTH,  x - resizeState.canvasX),
    height: Math.max(MIN_BOX_HEIGHT, y - resizeState.canvasY),
  });
  requestRender();
}

function onResizeEnd(e, handle) {
  if (!resizeState) return;
  handle.releasePointerCapture(e.pointerId);
  resizeState = null;
}

// ---------------------------------------------------------------------------
// Text persistence
// ---------------------------------------------------------------------------

function scheduleTextSave(annotationId, bodyEl) {
  clearTimeout(saveTimers.get(annotationId));
  const timer = setTimeout(() => {
    update(annotationId, { text: bodyEl.textContent });
    saveTimers.delete(annotationId);
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(annotationId, timer);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePageIndex(cx, cy) {
  for (const page of getPages()) {
    if (
      cx >= page.canvasX && cx <= page.canvasX + page.width &&
      cy >= page.canvasY && cy <= page.canvasY + page.height
    ) return page.pageIndex;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initNotes };
