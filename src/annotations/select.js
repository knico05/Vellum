/**
 * select.js — Rectangle selection and move tool
 *
 * Behaviour:
 *   1. Drag on empty canvas → draws a selection rectangle.
 *   2. Release → all annotations whose bounding boxes intersect the rect are selected.
 *      A dashed outline is drawn around the union bounding box of selected annotations.
 *   3. Pointer-down inside the selection → drag to move all selected annotations.
 *   4. Release → positions committed to manager (single emit, autosave fires once).
 *   5. Pointer-down outside selection → clears selection and starts a new one.
 *   6. Escape / deactivate → clears selection.
 *
 * Cross-module drag preview:
 *   getDragOffset(id) is exported and called by highlight.js, draw.js, and note.js
 *   during their render callbacks. While dragging, it returns {dx, dy} so each
 *   annotation draws itself at the offset position without permanently mutating state.
 *
 * Exports: initSelect(), activate(), deactivate(), getDragOffset()
 */

'use strict';

import { toCanvas, state as viewportState } from '../canvas/viewport.js';
import { registerOverlay, requestRender }   from '../canvas/renderer.js';
import { getAll, batchUpdate }              from './manager.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let active    = false;
let container = null;

// Drawing a new selection rectangle (pointerdown → pointermove → pointerup)
let selectionRect = null;   // {x1,y1,x2,y2} in canvas coords, or null

// Committed selection
let selectedIds     = new Set();
let selectionBounds = null;   // {x,y,w,h} union bounding box in canvas coords

// Moving selected annotations
let dragging        = false;
let dragStart       = null;   // {x,y} canvas coords where drag started
let deltaX          = 0;
let deltaY          = 0;

// ---------------------------------------------------------------------------
// Public API — called by other annotation modules each render frame
// ---------------------------------------------------------------------------

/**
 * Returns the current drag offset for an annotation that is being moved,
 * or null if the annotation is not selected / not being dragged.
 *
 * @param {string} id
 * @returns {{dx:number, dy:number}|null}
 */
function getDragOffset(id) {
  if (dragging && selectedIds.has(id)) return { dx: deltaX, dy: deltaY };
  return null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function init() {
  container = document.getElementById('canvas-container');
  container.addEventListener('pointerdown',   onPointerDown);
  container.addEventListener('pointermove',   onPointerMove);
  container.addEventListener('pointerup',     onPointerUp);
  container.addEventListener('pointercancel', onPointerUp);

  // Escape clears selection
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active) clearSelection();
  });

  registerOverlay(drawOverlay);
}

function activate() {
  active = true;
  container.classList.add('tool-select');
}

function deactivate() {
  active = false;
  clearSelection();
  container.classList.remove('tool-select');
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  if (!active) return;
  if (e.pointerType === 'touch') return;
  e.stopImmediatePropagation();

  const { x: cx, y: cy } = clientToCanvas(e);

  if (selectionBounds && isInsideBounds(cx, cy, selectionBounds)) {
    // Inside existing selection → start drag
    dragging   = true;
    dragStart  = { x: cx, y: cy };
    deltaX     = 0;
    deltaY     = 0;
    container.classList.add('tool-select-drag');
  } else {
    // Outside → clear old selection and start a new rect
    clearSelection();
    selectionRect = { x1: cx, y1: cy, x2: cx, y2: cy };
  }
}

function onPointerMove(e) {
  if (!active) return;
  if (e.pointerType === 'touch') return;

  const { x: cx, y: cy } = clientToCanvas(e);

  if (dragging) {
    deltaX = cx - dragStart.x;
    deltaY = cy - dragStart.y;
    requestRender();
  } else if (selectionRect) {
    selectionRect.x2 = cx;
    selectionRect.y2 = cy;
    requestRender();
  }
}

function onPointerUp() {
  if (!active) return;

  if (dragging) {
    commitDrag();
    dragging  = false;
    dragStart = null;
    container.classList.remove('tool-select-drag');
    requestRender();
    return;
  }

  if (selectionRect) {
    finaliseSelection();
    selectionRect = null;
    requestRender();
  }
}

// ---------------------------------------------------------------------------
// Selection logic
// ---------------------------------------------------------------------------

/**
 * After the user releases the mouse, finds all annotations inside the rect
 * and marks them as selected.
 */
function finaliseSelection() {
  const { x1, y1, x2, y2 } = selectionRect;
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  // Ignore tiny drag (accidental click)
  if (maxX - minX < 4 && maxY - minY < 4) return;

  selectedIds.clear();
  for (const anno of getAll()) {
    if (annotationIntersectsRect(anno, minX, minY, maxX, maxY)) {
      selectedIds.add(anno.id);
    }
  }

  selectionBounds = selectedIds.size > 0
    ? computeUnionBounds(selectedIds)
    : null;
}

/**
 * Commits the current drag delta to the manager.
 * Uses batchUpdate so only one 'annotations-changed' event fires.
 */
function commitDrag() {
  if (deltaX === 0 && deltaY === 0) return;

  const updates = [];
  for (const anno of getAll()) {
    if (!selectedIds.has(anno.id)) continue;

    if (anno.points) {
      // Path-based annotations (draw + new highlight): offset the point array
      updates.push({
        id:      anno.id,
        changes: { points: anno.points.map(p => ({ ...p, x: p.x + deltaX, y: p.y + deltaY })) },
      });
    } else {
      // Rect-based annotations (textBox, legacy highlight): offset the origin
      updates.push({
        id:      anno.id,
        changes: { canvasX: anno.canvasX + deltaX, canvasY: anno.canvasY + deltaY },
      });
    }
  }

  if (updates.length > 0) batchUpdate(updates);

  // Update stored selectionBounds to reflect new position
  if (selectionBounds) {
    selectionBounds = {
      x: selectionBounds.x + deltaX,
      y: selectionBounds.y + deltaY,
      w: selectionBounds.w,
      h: selectionBounds.h,
    };
  }

  deltaX = 0;
  deltaY = 0;
}

/**
 * Clears the selection state and triggers a repaint.
 */
function clearSelection() {
  selectedIds.clear();
  selectionRect   = null;
  selectionBounds = null;
  dragging        = false;
  dragStart       = null;
  deltaX          = 0;
  deltaY          = 0;
  requestRender();
}

// ---------------------------------------------------------------------------
// Overlay drawing
// ---------------------------------------------------------------------------

/**
 * Draws the selection rectangle (while dragging) and the selection bounds
 * outline (when annotations are selected). Called every frame by the renderer.
 *
 * @param {CanvasRenderingContext2D} ctx
 */
function drawOverlay(ctx) {
  const scale = viewportState.scale;
  const hairline = 1.5 / scale;
  const dash     = 5  / scale;

  // Live selection rectangle (while user is drawing the selection area)
  if (selectionRect) {
    const { x1, y1, x2, y2 } = selectionRect;
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);

    ctx.save();
    ctx.setLineDash([dash, dash]);
    ctx.lineWidth   = hairline;
    ctx.strokeStyle = 'rgba(91, 138, 245, 0.9)';
    ctx.fillStyle   = 'rgba(91, 138, 245, 0.06)';
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Selection bounds outline (around selected annotations, including drag offset)
  if (selectedIds.size > 0 && selectionBounds) {
    const dx = dragging ? deltaX : 0;
    const dy = dragging ? deltaY : 0;
    const pad = 6 / scale;
    const { x, y, w, h } = selectionBounds;

    ctx.save();
    ctx.setLineDash([dash, dash]);
    ctx.lineWidth   = hairline;
    ctx.strokeStyle = 'rgba(91, 138, 245, 0.85)';
    ctx.strokeRect(x + dx - pad, y + dy - pad, w + pad * 2, h + pad * 2);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a PointerEvent's client position to canvas coordinates.
 */
function clientToCanvas(e) {
  const rect = container.getBoundingClientRect();
  return toCanvas(e.clientX - rect.left, e.clientY - rect.top);
}

/**
 * Returns true if (cx, cy) is inside the bounds object {x,y,w,h}.
 */
function isInsideBounds(cx, cy, bounds) {
  return (
    cx >= bounds.x &&
    cx <= bounds.x + bounds.w &&
    cy >= bounds.y &&
    cy <= bounds.y + bounds.h
  );
}

/**
 * Returns true if the annotation's bounding box intersects the given rect.
 *
 * @param {object} anno
 * @param {number} minX
 * @param {number} minY
 * @param {number} maxX
 * @param {number} maxY
 * @returns {boolean}
 */
function annotationIntersectsRect(anno, minX, minY, maxX, maxY) {
  let ax, ay, aw, ah;

  if (anno.type === 'textBox' || anno.type === 'image') {
    // Rect-based annotations: explicit canvasX/Y/width/height
    ax = anno.canvasX; ay = anno.canvasY; aw = anno.width; ah = anno.height;
  } else if (anno.type === 'draw' || (anno.type === 'highlight' && anno.points)) {
    // Path-based annotations: compute bounding box from points
    let pMinX = Infinity, pMinY = Infinity, pMaxX = -Infinity, pMaxY = -Infinity;
    for (const p of anno.points) {
      if (p.x < pMinX) pMinX = p.x;
      if (p.y < pMinY) pMinY = p.y;
      if (p.x > pMaxX) pMaxX = p.x;
      if (p.y > pMaxY) pMaxY = p.y;
    }
    ax = pMinX; ay = pMinY; aw = pMaxX - pMinX; ah = pMaxY - pMinY;
  } else if (anno.type === 'highlight' && anno.canvasX !== undefined) {
    // Legacy rect-based highlight
    ax = anno.canvasX; ay = anno.canvasY; aw = anno.width; ah = anno.height;
  } else {
    return false;
  }

  // Axis-aligned bounding box intersection
  return !(ax + aw < minX || ax > maxX || ay + ah < minY || ay > maxY);
}

/**
 * Computes the union bounding box of a set of annotation IDs.
 *
 * @param {Set<string>} ids
 * @returns {{x:number, y:number, w:number, h:number}}
 */
function computeUnionBounds(ids) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const anno of getAll()) {
    if (!ids.has(anno.id)) continue;

    if (anno.type === 'textBox' || anno.type === 'image') {
      minX = Math.min(minX, anno.canvasX);
      minY = Math.min(minY, anno.canvasY);
      maxX = Math.max(maxX, anno.canvasX + anno.width);
      maxY = Math.max(maxY, anno.canvasY + anno.height);
    } else if (anno.type === 'draw' || (anno.type === 'highlight' && anno.points)) {
      for (const p of anno.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    } else if (anno.type === 'highlight' && anno.canvasX !== undefined) {
      minX = Math.min(minX, anno.canvasX);
      minY = Math.min(minY, anno.canvasY);
      maxX = Math.max(maxX, anno.canvasX + anno.width);
      maxY = Math.max(maxY, anno.canvasY + anno.height);
    }
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initSelect, activate, deactivate, getDragOffset };
