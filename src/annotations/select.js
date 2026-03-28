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

import { toCanvas, toScreen, state as viewportState } from '../canvas/viewport.js';
import { registerOverlay, requestRender }             from '../canvas/renderer.js';
import { getAll, batchUpdate, add, remove }           from './manager.js';

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

/** Floating action bar DOM element (duplicate + delete buttons) */
let actionBarEl = null;

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
    if (e.key === 'Escape' && active) {
      clearSelection();
      return;
    }
    // Ctrl+D: duplicate selected annotations
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D') &&
        active && selectedIds.size > 0) {
      e.preventDefault();
      duplicateSelection();
    }
  });

  // Build floating action bar (tablet-friendly buttons above selection)
  actionBarEl = document.createElement('div');
  actionBarEl.className = 'selection-action-bar hidden';
  actionBarEl.innerHTML = `
    <button class="selection-action-btn" id="btn-sel-duplicate" title="Duplicate">
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="7" y="7" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
        <path d="M5 13H4a1.5 1.5 0 01-1.5-1.5V4A1.5 1.5 0 014 2.5h7.5A1.5 1.5 0 0113 4v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
    <button class="selection-action-btn selection-action-btn-delete" id="btn-sel-delete" title="Delete">
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 6h12M8 6V4h4v2M7 9v6M10 9v6M13 9v6M5 6l1 11h8l1-11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  `;
  document.body.appendChild(actionBarEl);

  actionBarEl.querySelector('#btn-sel-duplicate').addEventListener('click', (e) => {
    e.stopPropagation();
    duplicateSelection();
  });
  actionBarEl.querySelector('#btn-sel-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteSelection();
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
  updateActionBar();
}

/**
 * Commits the drag delta to the manager.
 * Captures the before-state (undoPatch) so the move can be undone with Ctrl+Z.
 * Uses batchUpdate so only one 'annotations-changed' event fires.
 */
function commitDrag() {
  if (deltaX === 0 && deltaY === 0) return;

  const updates   = [];
  const undoPatch = [];

  for (const anno of getAll()) {
    if (!selectedIds.has(anno.id)) continue;

    if (anno.points) {
      // Capture old points for undo before computing the new positions
      undoPatch.push({
        id:      anno.id,
        changes: { points: anno.points },
      });
      updates.push({
        id:      anno.id,
        changes: { points: anno.points.map(p => ({ ...p, x: p.x + deltaX, y: p.y + deltaY })) },
      });
    } else {
      undoPatch.push({
        id:      anno.id,
        changes: { canvasX: anno.canvasX, canvasY: anno.canvasY },
      });
      updates.push({
        id:      anno.id,
        changes: { canvasX: anno.canvasX + deltaX, canvasY: anno.canvasY + deltaY },
      });
    }
  }

  if (updates.length > 0) batchUpdate(updates, undoPatch);

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
 * Duplicates all selected annotations with a small canvas offset and selects
 * the new copies. Each copy is added via manager.add() so it lands on the
 * undo stack individually and can be reversed with Ctrl+Z.
 *
 * Offset (16 canvas units) is large enough to be visible but small enough
 * that the duplicate clearly belongs near the original.
 */
function duplicateSelection() {
  const OFFSET = 16;
  const newIds  = [];

  for (const anno of getAll()) {
    if (!selectedIds.has(anno.id)) continue;

    // Strip manager-assigned fields so add() generates fresh ones
    const { id, createdAt, updatedAt, ...rest } = anno;

    let copy;
    if (rest.points) {
      // Path-based annotation (draw, highlight) — offset every point
      copy = { ...rest, points: rest.points.map(p => ({ ...p, x: p.x + OFFSET, y: p.y + OFFSET })) };
    } else {
      // Position-based annotation (textBox, image) — offset canvasX/Y
      copy = { ...rest, canvasX: rest.canvasX + OFFSET, canvasY: rest.canvasY + OFFSET };
    }

    const added = add(copy);
    newIds.push(added.id);
  }

  // Switch selection to the new copies
  selectedIds.clear();
  for (const newId of newIds) selectedIds.add(newId);
  selectionBounds = selectedIds.size > 0 ? computeUnionBounds(selectedIds) : null;
  updateActionBar();
  requestRender();
}

/**
 * Removes all selected annotations from the manager.
 */
function deleteSelection() {
  for (const id of selectedIds) remove(id);
  clearSelection();
}

function clearSelection() {
  selectedIds.clear();
  lassoPoints     = null;
  selectionBounds = null;
  dragging        = false;
  dragStart       = null;
  deltaX          = 0;
  deltaY          = 0;
  updateActionBar();
  requestRender();
}

/**
 * Positions the floating action bar above the selection bounding box.
 * Called every frame from drawOverlay so it tracks pan/zoom correctly.
 */
function updateActionBar() {
  if (!actionBarEl) return;
  if (!selectedIds.size || !selectionBounds) {
    actionBarEl.classList.add('hidden');
    return;
  }
  actionBarEl.classList.remove('hidden');
  // Place bar above the centre-top of the selection bounding box
  const midCanvasX = selectionBounds.x + selectionBounds.w / 2;
  const topCanvasY = selectionBounds.y + (dragging ? deltaY : 0);
  const { x: sx, y: sy } = toScreen(midCanvasX, topCanvasY);
  const barW = actionBarEl.offsetWidth  || 80;
  const barH = actionBarEl.offsetHeight || 36;
  actionBarEl.style.left = `${Math.round(sx - barW / 2)}px`;
  actionBarEl.style.top  = `${Math.round(sy - barH - 8)}px`;
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
  // Keep the DOM action bar in sync with the current viewport each frame
  updateActionBar();

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
