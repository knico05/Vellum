/**
 * select.js — Freeform lasso selection and move tool
 *
 * Behaviour:
 *   1. Drag on the canvas → draws a freehand lasso polygon.
 *   2. Release → the polygon is closed and any annotation whose centroid
 *      falls inside the polygon is selected. A dashed bounding-box outline
 *      is drawn around the union of all selected annotations.
 *   3. Pointer-down inside the bounding box → drag to move all selected
 *      annotations together.
 *   4. Release → positions are committed to the manager (one emit so autosave
 *      fires once).
 *   5. Pointer-down outside the bounding box → clears selection and starts a
 *      new lasso.
 *   6. Escape / deactivate → clears selection.
 *
 * Point-in-polygon check uses the ray-casting algorithm, which correctly handles
 * concave and self-intersecting shapes.
 *
 * Cross-module drag preview:
 *   getDragOffset(id) is called every frame by highlight.js, draw.js, note.js,
 *   and image.js. While dragging it returns {dx, dy} so each annotation draws
 *   itself at the offset position without permanently mutating state.
 *
 * Exports: initSelect(), activate(), deactivate(), getDragOffset()
 */

'use strict';

import { toCanvas, state as viewportState } from '../canvas/viewport.js';
import { registerOverlay, requestRender }   from '../canvas/renderer.js';
import { getAll, batchUpdate }              from './manager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum canvas-unit distance between consecutive lasso points.
 * Filters out micro-movements to keep the polygon manageable.
 */
const MIN_LASSO_DISTANCE = 3;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let active    = false;
let container = null;

/** Points of the lasso being drawn (canvas coordinates), or null */
let lassoPoints = null;

/** Committed selection */
let selectedIds     = new Set();
let selectionBounds = null;  // {x, y, w, h} union bounding box in canvas coords

/** Moving selected annotations */
let dragging   = false;
let dragStart  = null;  // {x, y} canvas coords
let deltaX     = 0;
let deltaY     = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current drag offset for an annotation, or null if it is not
 * selected / not being dragged. Called every frame by other annotation modules.
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
    // Inside existing selection bounding box → start drag-move
    dragging  = true;
    dragStart = { x: cx, y: cy };
    deltaX    = 0;
    deltaY    = 0;
    container.classList.add('tool-select-drag');
  } else {
    // Outside or no selection → clear and start a new lasso
    clearSelection();
    lassoPoints = [{ x: cx, y: cy }];
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
  } else if (lassoPoints) {
    const last = lassoPoints[lassoPoints.length - 1];
    const dx   = cx - last.x;
    const dy   = cy - last.y;
    // Only record when the pointer has moved far enough
    if (Math.sqrt(dx * dx + dy * dy) >= MIN_LASSO_DISTANCE) {
      lassoPoints.push({ x: cx, y: cy });
      requestRender();
    }
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

  if (lassoPoints && lassoPoints.length >= 3) {
    finaliseSelection();
  }
  lassoPoints = null;
  requestRender();
}

// ---------------------------------------------------------------------------
// Selection logic
// ---------------------------------------------------------------------------

/**
 * Closes the lasso polygon and selects every annotation whose centroid falls
 * inside it. Uses ray-casting for the point-in-polygon check.
 */
function finaliseSelection() {
  selectedIds.clear();

  for (const anno of getAll()) {
    if (anno.type === 'blankPage') continue; // blank pages are not selectable

    const { cx, cy } = annotationCentroid(anno);
    if (cx === null) continue;

    if (pointInPolygon(cx, cy, lassoPoints)) {
      selectedIds.add(anno.id);
    }
  }

  selectionBounds = selectedIds.size > 0
    ? computeUnionBounds(selectedIds)
    : null;
}

/**
 * Commits the drag delta to the manager.
 * Uses batchUpdate so only one 'annotations-changed' event fires.
 */
function commitDrag() {
  if (deltaX === 0 && deltaY === 0) return;

  const updates = [];
  for (const anno of getAll()) {
    if (!selectedIds.has(anno.id)) continue;

    if (anno.points) {
      updates.push({
        id:      anno.id,
        changes: { points: anno.points.map(p => ({ ...p, x: p.x + deltaX, y: p.y + deltaY })) },
      });
    } else {
      updates.push({
        id:      anno.id,
        changes: { canvasX: anno.canvasX + deltaX, canvasY: anno.canvasY + deltaY },
      });
    }
  }

  if (updates.length > 0) batchUpdate(updates);

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

function clearSelection() {
  selectedIds.clear();
  lassoPoints     = null;
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
 * Draws the live lasso path while dragging, and the selection bounding-box
 * outline when annotations are selected. Called every frame by the renderer.
 *
 * @param {CanvasRenderingContext2D} ctx — already in canvas space
 */
function drawOverlay(ctx) {
  const scale    = viewportState.scale;
  const hairline = 1.5 / scale;
  const dash     = 5   / scale;

  // ── Live lasso (user is still drawing) ──────────────────────────────────
  if (lassoPoints && lassoPoints.length >= 2) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) {
      ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    }
    // Don't close the path while drawing — closing only happens on release
    ctx.setLineDash([dash, dash]);
    ctx.lineWidth   = hairline;
    ctx.strokeStyle = 'rgba(91, 138, 245, 0.9)';
    ctx.fillStyle   = 'rgba(91, 138, 245, 0.06)';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }

  // ── Selection bounding-box outline (after selection is committed) ────────
  if (selectedIds.size > 0 && selectionBounds) {
    const dx  = dragging ? deltaX : 0;
    const dy  = dragging ? deltaY : 0;
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
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Ray-casting point-in-polygon test.
 * Returns true if (px, py) is inside the polygon defined by vertices.
 *
 * @param {number} px
 * @param {number} py
 * @param {Array<{x:number, y:number}>} polygon
 * @returns {boolean}
 */
function pointInPolygon(px, py, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect =
      (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Returns the centroid of an annotation — the representative point used for
 * lasso containment testing.
 *
 * @param {object} anno
 * @returns {{ cx: number|null, cy: number|null }}
 */
function annotationCentroid(anno) {
  if (anno.type === 'textBox' || anno.type === 'image') {
    return {
      cx: anno.canvasX + anno.width  / 2,
      cy: anno.canvasY + anno.height / 2,
    };
  }

  if ((anno.type === 'draw' || anno.type === 'highlight') && anno.points?.length) {
    let sumX = 0, sumY = 0;
    for (const p of anno.points) { sumX += p.x; sumY += p.y; }
    return { cx: sumX / anno.points.length, cy: sumY / anno.points.length };
  }

  if (anno.type === 'highlight' && anno.canvasX !== undefined) {
    return {
      cx: anno.canvasX + (anno.width  ?? 0) / 2,
      cy: anno.canvasY + (anno.height ?? 0) / 2,
    };
  }

  return { cx: null, cy: null };
}

/**
 * Returns true if the canvas point (cx, cy) is inside the bounding box.
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

/**
 * Converts a PointerEvent's client position to canvas coordinates.
 */
function clientToCanvas(e) {
  const rect = container.getBoundingClientRect();
  return toCanvas(e.clientX - rect.left, e.clientY - rect.top);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initSelect, activate, deactivate, getDragOffset };
