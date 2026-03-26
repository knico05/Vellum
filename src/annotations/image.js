/**
 * image.js — Image annotation (DOM overlay approach)
 *
 * Image annotations are absolutely positioned <div> elements containing an
 * <img> tag. They pan and zoom with the viewport via CSS transform, identical
 * to text boxes. The image data is stored as a base64 data URL inside the
 * annotation object.
 *
 * Annotation schema:
 *   { type:'image', pageIndex, canvasX, canvasY, width, height, dataUrl }
 *
 * Exports: initImages(), addImage()
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

const MIN_WIDTH  = 40;
const MIN_HEIGHT = 40;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let container = null;

/** Map of annotation id → wrapper DOM element */
const imgElements = new Map();

let resizeState = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  container = document.getElementById('canvas-container');
  document.addEventListener('annotations-changed', syncElements);
  register(updatePositions);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Adds an image annotation to the canvas.
 * Called by screenshot.js after a region is captured.
 *
 * @param {string} dataUrl  — PNG data URL
 * @param {number} canvasX  — Canvas-space left edge
 * @param {number} canvasY  — Canvas-space top edge
 * @param {number} width    — Canvas-space width
 * @param {number} height   — Canvas-space height
 * @param {number} pageIndex
 */
function addImage(dataUrl, canvasX, canvasY, width, height, pageIndex) {
  add({
    type: 'image',
    pageIndex: pageIndex ?? resolvePageIndex(canvasX + width / 2, canvasY + height / 2),
    canvasX, canvasY, width, height,
    dataUrl,
  });
}

// ---------------------------------------------------------------------------
// DOM ↔ store sync
// ---------------------------------------------------------------------------

function syncElements() {
  const annotations = getAll().filter(a => a.type === 'image');
  const currentIds  = new Set(annotations.map(a => a.id));

  for (const [id, el] of imgElements) {
    if (!currentIds.has(id)) {
      el.remove();
      imgElements.delete(id);
    }
  }

  for (const anno of annotations) {
    if (!imgElements.has(anno.id)) {
      const el = createImageElement(anno);
      container.appendChild(el);
      imgElements.set(anno.id, el);
    } else {
      const el = imgElements.get(anno.id);
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

  for (const [id, el] of imgElements) {
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

function createImageElement(anno) {
  const el = document.createElement('div');
  el.className  = 'image-anno';
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

  // ── Image ─────────────────────────────────────────────────────────────────
  const img = document.createElement('img');
  img.src            = anno.dataUrl;
  img.draggable      = false;
  img.style.cssText  = 'width:100%;height:100%;display:block;object-fit:contain;border-radius:inherit;';

  // ── Delete button ─────────────────────────────────────────────────────────
  const deleteBtn = document.createElement('button');
  deleteBtn.className   = 'image-anno-delete';
  deleteBtn.textContent = '×';
  deleteBtn.title       = 'Delete';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    remove(anno.id);
  });

  // ── Resize handle (bottom-right) ──────────────────────────────────────────
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'image-anno-resize';

  el.appendChild(img);
  el.appendChild(deleteBtn);
  el.appendChild(resizeHandle);

  // ── Resize wiring ─────────────────────────────────────────────────────────
  resizeHandle.addEventListener('pointerdown',   (e) => onResizeStart(e, anno.id, resizeHandle));
  resizeHandle.addEventListener('pointermove',   onResizeMove);
  resizeHandle.addEventListener('pointerup',     (e) => onResizeEnd(e, resizeHandle));
  resizeHandle.addEventListener('pointercancel', (e) => onResizeEnd(e, resizeHandle));

  // Block canvas pan/zoom while interacting
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('wheel',       (e) => e.stopPropagation());

  return el;
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
    width:  Math.max(MIN_WIDTH,  x - resizeState.canvasX),
    height: Math.max(MIN_HEIGHT, y - resizeState.canvasY),
  });
  requestRender();
}

function onResizeEnd(e, handle) {
  if (!resizeState) return;
  handle.releasePointerCapture(e.pointerId);
  resizeState = null;
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

export { init as initImages, addImage };
