/**
 * select.js — Freeform lasso selection, move, and resize tool
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
 *   5. Pointer-down on a handle → shape-specific edit (see Handle modes below).
 *   6. Pointer-down outside → clears selection and starts a new lasso.
 *   7. Escape / deactivate → clears selection.
 *
 * Handle modes (single annotation selected):
 *   line   — 2 handles at the two endpoints; drag to reposition either end.
 *   rect   — 4 handles at the actual corner points; drag a corner to resize.
 *   circle — center handle (drag to move) + radius handle at (cx+r, cy) (drag
 *             to resize the radius).
 *   bounds — fallback (freehand draw, textBox, image, multi-selection): 4
 *             handles at the padded bounding-box corners, proportional scale.
 *
 * Annotation type support:
 *   draw (points[], shaped line/rect), draw circle (cx/cy/r),
 *   highlight (points[] or canvasX/Y/w/h), textBox, image.
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

const MIN_LASSO_DISTANCE = 3;

/**
 * Padding (canvas units) added around selectionBounds for the drag-move hit
 * test. Keeps lines and tiny shapes interactive.
 */
const INTERACTION_PAD = 12;

/**
 * Padding (canvas units) added around selectionBounds when drawing the dashed
 * outline and positioning bounds-mode corner handles.
 */
const BOUNDS_PAD_CANVAS = 6;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let active    = false;
let container = null;

/** Floating action bar DOM element (duplicate + delete buttons) */
let actionBarEl = null;

/** Corner resize handle DOM elements keyed by position: 'tl'|'tr'|'bl'|'br' */
const handleEls = {};

/** Points of the lasso being drawn (canvas coordinates), or null */
let lassoPoints = null;

/** Committed selection */
let selectedIds     = new Set();
let selectionBounds = null;  // {x, y, w, h} union bounding box in canvas coords

/** Drag-move state */
let dragging   = false;
let dragStart  = null;
let deltaX     = 0;
let deltaY     = 0;

/**
 * Resize / shape-edit state.
 * resizeHandle encodes both mode and which element is being dragged:
 *   'line_p0' | 'line_p1'
 *   'rect_tl' | 'rect_tr' | 'rect_br' | 'rect_bl'
 *   'circle_center' | 'circle_radius'
 *   'bounds_tl' | 'bounds_tr' | 'bounds_br' | 'bounds_bl'
 */
let resizing        = false;
let resizeHandle    = null;
let resizeOrigin    = null;   // fixed anchor for bounds-mode scale
let originalBounds  = null;
let resizeBounds    = null;   // live updated bounds during bounds-mode resize
let resizeOriginals = {};     // id → snapshot of original annotation fields

/**
 * Live preview geometry during a shape-specific edit.
 * { mode: 'line'|'rect'|'circle', ...shapeData }
 * Drawn in drawOverlay instead of the static selection box.
 */
let resizePreview = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current drag offset for an annotation, or null if it is not
 * selected / not being dragged.
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

  // Build 4 corner resize handles
  for (const pos of ['tl', 'tr', 'bl', 'br']) {
    const el = document.createElement('div');
    el.className = `selection-handle selection-handle-${pos} hidden`;
    el.dataset.handle = pos;
    document.body.appendChild(el);
    handleEls[pos] = el;

    el.addEventListener('pointerdown', (e) => {
      if (!active || !selectionBounds) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      startResize(pos, e);
    });
    el.addEventListener('pointermove', onResizeMove);
    el.addEventListener('pointerup',   onResizeUp);
  }

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
// Handle mode helpers
// ---------------------------------------------------------------------------

/**
 * Returns the current handle mode based on what is selected.
 * @returns {'line'|'rect'|'circle'|'bounds'}
 */
function getHandleMode() {
  if (selectedIds.size !== 1) return 'bounds';
  const anno = getSingleAnno();
  if (!anno) return 'bounds';
  if (anno.shapeType === 'line')   return 'line';
  if (anno.shapeType === 'rect')   return 'rect';
  if (anno.shapeType === 'circle') return 'circle';
  return 'bounds';
}

/** Returns the single selected annotation, or null. */
function getSingleAnno() {
  if (selectedIds.size !== 1) return null;
  const [id] = selectedIds;
  return getAll().find(a => a.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Input handlers — lasso and drag-move
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  if (!active) return;
  if (e.pointerType === 'touch') return;
  e.stopImmediatePropagation();

  const { x: cx, y: cy } = clientToCanvas(e);

  if (selectionBounds && isInsideBounds(cx, cy, expandBounds(selectionBounds, INTERACTION_PAD))) {
    // Inside existing selection → start drag-move
    dragging  = true;
    dragStart = { x: cx, y: cy };
    deltaX    = 0;
    deltaY    = 0;
    container.classList.add('tool-select-drag');
  } else {
    // Outside → clear and start a new lasso
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
// Resize / shape-edit handlers
// ---------------------------------------------------------------------------

/**
 * Starts a shape-specific edit when a corner handle is grabbed.
 * Routes to the correct sub-behaviour based on getHandleMode().
 *
 * @param {'tl'|'tr'|'bl'|'br'} handlePos — which DOM handle was grabbed
 * @param {PointerEvent} e
 */
function startResize(handlePos, e) {
  const mode = getHandleMode();
  const anno = getSingleAnno();

  if (mode === 'line' && anno?.points?.length >= 2) {
    // 'tl' → endpoint 0, 'br' → endpoint 1
    resizeHandle = handlePos === 'tl' ? 'line_p0' : 'line_p1';
    resizeOriginals[anno.id] = { points: anno.points.map(p => ({ ...p })) };
    const pts = anno.points;
    resizePreview = {
      mode: 'line',
      p0: { x: pts[0].x, y: pts[0].y },
      p1: { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y },
    };
    resizing = true;

  } else if (mode === 'rect' && anno?.points?.length === 4) {
    // Each corner handle maps to one corner; the opposite corner is the anchor.
    const cornerMap = { tl: 0, tr: 1, br: 2, bl: 3 };
    const anchorMap = { tl: 2, tr: 3, br: 0, bl: 1 };
    const ci = cornerMap[handlePos];
    const ai = anchorMap[handlePos];
    resizeHandle  = `rect_${handlePos}`;
    resizeOrigin  = { x: anno.points[ai].x, y: anno.points[ai].y };
    resizeOriginals[anno.id] = { points: anno.points.map(p => ({ ...p })) };
    resizePreview = { mode: 'rect', points: anno.points.map(p => ({ ...p })) };
    resizing = true;

  } else if (mode === 'circle' && anno) {
    resizeOriginals[anno.id] = { cx: anno.cx, cy: anno.cy, r: anno.r, shapeType: 'circle' };

    if (handlePos === 'tl') {
      // Center handle → drag-move the whole circle via the existing drag system
      resizeHandle = 'circle_center';
      dragging  = true;
      dragStart = clientToCanvas(e);
      deltaX    = 0;
      deltaY    = 0;
      resizing  = true; // keep true so handle's pointermove/up route to us
    } else {
      // Radius handle → drag to resize
      resizeHandle  = 'circle_radius';
      resizePreview = { mode: 'circle', cx: anno.cx, cy: anno.cy, r: anno.r };
      resizing = true;
    }

  } else {
    // Bounds mode: proportional scale from the opposite corner
    const { x, y, w, h } = selectionBounds;
    const anchors = {
      tl: { x: x + w, y: y + h },
      tr: { x: x,     y: y + h },
      bl: { x: x + w, y: y     },
      br: { x: x,     y: y     },
    };
    resizeHandle   = `bounds_${handlePos}`;
    resizeOrigin   = anchors[handlePos];
    originalBounds = { ...selectionBounds };
    resizeBounds   = { ...selectionBounds };

    resizeOriginals = {};
    for (const a of getAll()) {
      if (!selectedIds.has(a.id)) continue;
      const snap = { shapeType: a.shapeType };
      if (a.points?.length)           snap.points  = a.points.map(p => ({ ...p }));
      else if (a.shapeType === 'circle') { snap.cx = a.cx; snap.cy = a.cy; snap.r = a.r; }
      else if (a.canvasX !== undefined)  { snap.canvasX = a.canvasX; snap.canvasY = a.canvasY; snap.width = a.width; snap.height = a.height; }
      resizeOriginals[a.id] = snap;
    }
    resizing = true;
  }

  requestRender();
}

function onResizeMove(e) {
  if (!resizing) return;
  const { x: cx, y: cy } = clientToCanvas(e);
  const anno = getSingleAnno();

  if (resizeHandle === 'circle_center') {
    // Routed through drag-move: update delta
    deltaX = cx - dragStart.x;
    deltaY = cy - dragStart.y;

  } else if (resizeHandle === 'line_p0' || resizeHandle === 'line_p1') {
    if (!resizePreview) return;
    if (resizeHandle === 'line_p0') resizePreview.p0 = { x: cx, y: cy };
    else                            resizePreview.p1 = { x: cx, y: cy };

  } else if (resizeHandle?.startsWith('rect_') && resizePreview?.mode === 'rect') {
    // Moving one corner; recompute the 4 corners while keeping the anchor fixed.
    // A rect's corners: [TL=0, TR=1, BR=2, BL=3]
    // Anchor is the diagonal opposite. We must keep its axis-partner axes:
    //   dragging TL (idx 0) → anchor BR (idx 2): keep anchor.x/anchor.y fixed
    //   TL.x=ptr.x, TL.y=ptr.y, TR.x=anchor.x, TR.y=ptr.y, BL.x=ptr.x, BL.y=anchor.y
    const anchorX = resizeOrigin.x;
    const anchorY = resizeOrigin.y;
    const minX = Math.min(cx, anchorX);
    const minY = Math.min(cy, anchorY);
    const maxX = Math.max(cx, anchorX);
    const maxY = Math.max(cy, anchorY);
    resizePreview.points = [
      { x: minX, y: minY, pressure: 0.5 }, // TL
      { x: maxX, y: minY, pressure: 0.5 }, // TR
      { x: maxX, y: maxY, pressure: 0.5 }, // BR
      { x: minX, y: maxY, pressure: 0.5 }, // BL
    ];

  } else if (resizeHandle === 'circle_radius' && resizePreview?.mode === 'circle') {
    const dx = cx - resizePreview.cx;
    const dy = cy - resizePreview.cy;
    resizePreview.r = Math.max(5, Math.sqrt(dx * dx + dy * dy));

  } else if (resizeHandle?.startsWith('bounds_') && resizeOrigin) {
    // Proportional bounding-box scale
    const ax = resizeOrigin.x;
    const ay = resizeOrigin.y;
    resizeBounds = {
      x: Math.min(ax, cx),
      y: Math.min(ay, cy),
      w: Math.abs(cx - ax),
      h: Math.abs(cy - ay),
    };
  }

  requestRender();
}

function onResizeUp() {
  if (!resizing) return;
  commitResize();
  resizing      = false;
  resizeHandle  = null;
  resizeBounds  = null;
  resizePreview = null;
  dragging      = false;
  dragStart     = null;
  requestRender();
}

/**
 * Applies the pending resize to the manager and updates selectionBounds.
 */
function commitResize() {
  const anno = getSingleAnno();
  const mode = getHandleMode();

  if (resizeHandle === 'circle_center') {
    // Handled via the standard drag-move path
    commitDrag();
    return;
  }

  if ((resizeHandle === 'line_p0' || resizeHandle === 'line_p1') && anno && resizePreview) {
    const orig  = resizeOriginals[anno.id];
    const oldPts = orig.points;
    // Map preview endpoints back onto the full points array:
    // p0 maps to points[0], p1 maps to points[last]
    const newPts = oldPts.map((p, i) => {
      if (i === 0)             return { ...p, x: resizePreview.p0.x, y: resizePreview.p0.y };
      if (i === oldPts.length - 1) return { ...p, x: resizePreview.p1.x, y: resizePreview.p1.y };
      // Interpolate interior points proportionally
      const t = i / (oldPts.length - 1);
      return {
        ...p,
        x: resizePreview.p0.x + (resizePreview.p1.x - resizePreview.p0.x) * t,
        y: resizePreview.p0.y + (resizePreview.p1.y - resizePreview.p0.y) * t,
      };
    });
    batchUpdate(
      [{ id: anno.id, changes: { points: newPts } }],
      [{ id: anno.id, changes: { points: oldPts } }],
    );
    selectionBounds = computeUnionBounds(selectedIds);

  } else if (resizeHandle?.startsWith('rect_') && anno && resizePreview) {
    const orig = resizeOriginals[anno.id];
    batchUpdate(
      [{ id: anno.id, changes: { points: resizePreview.points } }],
      [{ id: anno.id, changes: { points: orig.points } }],
    );
    selectionBounds = computeUnionBounds(selectedIds);

  } else if (resizeHandle === 'circle_radius' && anno && resizePreview) {
    const orig = resizeOriginals[anno.id];
    batchUpdate(
      [{ id: anno.id, changes: { r: resizePreview.r } }],
      [{ id: anno.id, changes: { r: orig.r } }],
    );
    selectionBounds = computeUnionBounds(selectedIds);

  } else if (resizeHandle?.startsWith('bounds_') && resizeBounds && originalBounds) {
    // Proportional scale of all selected annotations from the anchor corner
    const scaleX = originalBounds.w > 0 ? resizeBounds.w / originalBounds.w : 1;
    const scaleY = originalBounds.h > 0 ? resizeBounds.h / originalBounds.h : 1;
    const ox = resizeOrigin.x;
    const oy = resizeOrigin.y;
    const updates   = [];
    const undoPatch = [];

    for (const a of getAll()) {
      if (!selectedIds.has(a.id)) continue;
      const orig = resizeOriginals[a.id];
      if (!orig) continue;

      if (orig.points?.length) {
        undoPatch.push({ id: a.id, changes: { points: a.points } });
        updates.push({
          id: a.id,
          changes: { points: orig.points.map(p => ({ ...p, x: ox + (p.x - ox) * scaleX, y: oy + (p.y - oy) * scaleY })) },
        });
      } else if (orig.shapeType === 'circle') {
        undoPatch.push({ id: a.id, changes: { cx: a.cx, cy: a.cy, r: a.r } });
        updates.push({
          id: a.id,
          changes: { cx: ox + (orig.cx - ox) * scaleX, cy: oy + (orig.cy - oy) * scaleY, r: orig.r * Math.max(scaleX, scaleY) },
        });
      } else if (orig.canvasX !== undefined) {
        undoPatch.push({ id: a.id, changes: { canvasX: a.canvasX, canvasY: a.canvasY, width: a.width, height: a.height } });
        updates.push({
          id: a.id,
          changes: { canvasX: ox + (orig.canvasX - ox) * scaleX, canvasY: oy + (orig.canvasY - oy) * scaleY, width: orig.width * scaleX, height: orig.height * scaleY },
        });
      }
    }
    if (updates.length > 0) batchUpdate(updates, undoPatch);
    selectionBounds = { ...resizeBounds };
  }

  resizeOriginals = {};
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
    if (anno.type === 'blankPage') continue;

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
 */
function commitDrag() {
  if (deltaX === 0 && deltaY === 0) return;

  const updates   = [];
  const undoPatch = [];

  for (const anno of getAll()) {
    if (!selectedIds.has(anno.id)) continue;

    if (anno.shapeType === 'circle') {
      undoPatch.push({ id: anno.id, changes: { cx: anno.cx, cy: anno.cy } });
      updates.push({ id: anno.id, changes: { cx: anno.cx + deltaX, cy: anno.cy + deltaY } });
    } else if (anno.points) {
      undoPatch.push({ id: anno.id, changes: { points: anno.points } });
      updates.push({
        id:      anno.id,
        changes: { points: anno.points.map(p => ({ ...p, x: p.x + deltaX, y: p.y + deltaY })) },
      });
    } else {
      undoPatch.push({ id: anno.id, changes: { canvasX: anno.canvasX, canvasY: anno.canvasY } });
      updates.push({ id: anno.id, changes: { canvasX: anno.canvasX + deltaX, canvasY: anno.canvasY + deltaY } });
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

function duplicateSelection() {
  const OFFSET = 16;
  const newIds  = [];

  for (const anno of getAll()) {
    if (!selectedIds.has(anno.id)) continue;

    const { id, createdAt, updatedAt, ...rest } = anno;

    let copy;
    if (rest.shapeType === 'circle') {
      copy = { ...rest, cx: rest.cx + OFFSET, cy: rest.cy + OFFSET };
    } else if (rest.points) {
      copy = { ...rest, points: rest.points.map(p => ({ ...p, x: p.x + OFFSET, y: p.y + OFFSET })) };
    } else {
      copy = { ...rest, canvasX: rest.canvasX + OFFSET, canvasY: rest.canvasY + OFFSET };
    }

    const added = add(copy);
    newIds.push(added.id);
  }

  selectedIds.clear();
  for (const newId of newIds) selectedIds.add(newId);
  selectionBounds = selectedIds.size > 0 ? computeUnionBounds(selectedIds) : null;
  updateActionBar();
  requestRender();
}

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
  resizing        = false;
  resizeHandle    = null;
  resizeOrigin    = null;
  originalBounds  = null;
  resizeBounds    = null;
  resizePreview   = null;
  resizeOriginals = {};
  updateActionBar();
  updateHandles();
  requestRender();
}

// ---------------------------------------------------------------------------
// DOM element positioning
// ---------------------------------------------------------------------------

function updateActionBar() {
  if (!actionBarEl) return;
  if (!selectedIds.size || !selectionBounds || resizing) {
    actionBarEl.classList.add('hidden');
    return;
  }
  actionBarEl.classList.remove('hidden');
  const midCanvasX = selectionBounds.x + selectionBounds.w / 2;
  const topCanvasY = selectionBounds.y + (dragging ? deltaY : 0);
  const { x: sx, y: sy } = toScreen(midCanvasX, topCanvasY);
  const barW = actionBarEl.offsetWidth  || 80;
  const barH = actionBarEl.offsetHeight || 36;
  actionBarEl.style.left = `${Math.round(sx - barW / 2)}px`;
  actionBarEl.style.top  = `${Math.round(sy - barH - 8)}px`;
}

/**
 * Positions and shows/hides the 4 corner handle DOM elements.
 * Handle placement depends on the current handle mode:
 *   line   — 2 handles at endpoints ('tl'=p0, 'br'=p1); tr/bl hidden
 *   rect   — 4 handles at the actual corner points
 *   circle — 'tl' at centre, 'br' at edge (cx+r, cy); tr/bl hidden
 *   bounds — 4 handles at padded bounding-box corners (existing behaviour)
 */
function updateHandles() {
  const show = active && selectedIds.size > 0 && selectionBounds && !lassoPoints;
  if (!show) {
    for (const el of Object.values(handleEls)) el.classList.add('hidden');
    return;
  }

  const mode = getHandleMode();
  const anno = getSingleAnno();

  if (mode === 'line' && anno?.points?.length >= 2 && !resizing) {
    const pts = anno.points;
    placeHandle('tl', toScreen(pts[0].x,                pts[0].y),                'move');
    placeHandle('br', toScreen(pts[pts.length - 1].x,   pts[pts.length - 1].y),   'move');
    handleEls.tr.classList.add('hidden');
    handleEls.bl.classList.add('hidden');

  } else if (mode === 'line' && resizePreview?.mode === 'line') {
    // During drag: show live preview positions
    placeHandle('tl', toScreen(resizePreview.p0.x, resizePreview.p0.y), 'move');
    placeHandle('br', toScreen(resizePreview.p1.x, resizePreview.p1.y), 'move');
    handleEls.tr.classList.add('hidden');
    handleEls.bl.classList.add('hidden');

  } else if (mode === 'rect' && anno?.points?.length === 4 && !resizing) {
    const p = anno.points;
    placeHandle('tl', toScreen(p[0].x, p[0].y), 'nwse-resize');
    placeHandle('tr', toScreen(p[1].x, p[1].y), 'nesw-resize');
    placeHandle('br', toScreen(p[2].x, p[2].y), 'nwse-resize');
    placeHandle('bl', toScreen(p[3].x, p[3].y), 'nesw-resize');

  } else if (mode === 'rect' && resizePreview?.mode === 'rect') {
    const p = resizePreview.points;
    placeHandle('tl', toScreen(p[0].x, p[0].y), 'nwse-resize');
    placeHandle('tr', toScreen(p[1].x, p[1].y), 'nesw-resize');
    placeHandle('br', toScreen(p[2].x, p[2].y), 'nwse-resize');
    placeHandle('bl', toScreen(p[3].x, p[3].y), 'nesw-resize');

  } else if (mode === 'circle' && anno && !resizing) {
    placeHandle('tl', toScreen(anno.cx,          anno.cy), 'move');
    placeHandle('br', toScreen(anno.cx + anno.r, anno.cy), 'ew-resize');
    handleEls.tr.classList.add('hidden');
    handleEls.bl.classList.add('hidden');

  } else if (mode === 'circle' && resizePreview?.mode === 'circle') {
    placeHandle('tl', toScreen(resizePreview.cx,                 resizePreview.cy), 'move');
    placeHandle('br', toScreen(resizePreview.cx + resizePreview.r, resizePreview.cy), 'ew-resize');
    handleEls.tr.classList.add('hidden');
    handleEls.bl.classList.add('hidden');

  } else if (mode === 'circle' && resizeHandle === 'circle_center' && dragging) {
    // Moving circle: show handles at offset positions
    const cx = anno ? anno.cx + deltaX : 0;
    const cy = anno ? anno.cy + deltaY : 0;
    const r  = anno ? anno.r  : 0;
    placeHandle('tl', toScreen(cx,     cy), 'move');
    placeHandle('br', toScreen(cx + r, cy), 'ew-resize');
    handleEls.tr.classList.add('hidden');
    handleEls.bl.classList.add('hidden');

  } else {
    // Bounds mode: 4 corners of the padded selection box
    const scale = viewportState.scale;
    const pad   = BOUNDS_PAD_CANVAS / scale;
    const { x, y, w, h } = resizeBounds ?? selectionBounds;
    placeHandle('tl', toScreen(x - pad,     y - pad),     'nwse-resize');
    placeHandle('tr', toScreen(x + w + pad, y - pad),     'nesw-resize');
    placeHandle('br', toScreen(x + w + pad, y + h + pad), 'nwse-resize');
    placeHandle('bl', toScreen(x - pad,     y + h + pad), 'nesw-resize');
  }
}

/**
 * Shows a handle element at screen position (sx, sy) with the given cursor.
 */
function placeHandle(pos, { x: sx, y: sy }, cursor) {
  const el = handleEls[pos];
  el.classList.remove('hidden');
  el.style.left   = `${Math.round(sx)}px`;
  el.style.top    = `${Math.round(sy)}px`;
  if (el.style.cursor !== cursor) el.style.cursor = cursor;
}

// ---------------------------------------------------------------------------
// Overlay drawing
// ---------------------------------------------------------------------------

/**
 * Draws the live lasso path, the selection bounding-box outline, and the live
 * shape preview during a shape-specific edit. Called every frame by the renderer.
 *
 * @param {CanvasRenderingContext2D} ctx — already in canvas space
 */
function drawOverlay(ctx) {
  updateActionBar();
  updateHandles();

  const scale    = viewportState.scale;
  const hairline = 1.5 / scale;
  const dash     = 5   / scale;

  // ── Live lasso ──────────────────────────────────────────────────────────
  if (lassoPoints && lassoPoints.length >= 2) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) {
      ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    }
    ctx.setLineDash([dash, dash]);
    ctx.lineWidth   = hairline;
    ctx.strokeStyle = 'rgba(91, 138, 245, 0.9)';
    ctx.fillStyle   = 'rgba(91, 138, 245, 0.06)';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }

  // ── Live shape-edit preview ──────────────────────────────────────────────
  if (resizing && resizePreview) {
    ctx.save();
    ctx.setLineDash([dash, dash]);
    ctx.lineWidth   = hairline;
    ctx.strokeStyle = 'rgba(91, 138, 245, 0.85)';

    if (resizePreview.mode === 'line') {
      ctx.beginPath();
      ctx.moveTo(resizePreview.p0.x, resizePreview.p0.y);
      ctx.lineTo(resizePreview.p1.x, resizePreview.p1.y);
      ctx.stroke();

    } else if (resizePreview.mode === 'rect') {
      const p = resizePreview.points;
      ctx.beginPath();
      ctx.moveTo(p[0].x, p[0].y);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
      ctx.closePath();
      ctx.stroke();

    } else if (resizePreview.mode === 'circle') {
      ctx.beginPath();
      ctx.arc(resizePreview.cx, resizePreview.cy, resizePreview.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
    return; // Skip the bounding box while editing shape geometry
  }

  // ── Selection bounding-box outline ──────────────────────────────────────
  if (selectedIds.size > 0 && selectionBounds) {
    const dx  = dragging ? deltaX : 0;
    const dy  = dragging ? deltaY : 0;
    const pad = BOUNDS_PAD_CANVAS / scale;

    const mode = getHandleMode();

    if (mode === 'bounds') {
      // Only draw the padded box for bounds mode; shape modes use geometry handles only
      const { x, y, w, h } = selectionBounds;
      ctx.save();
      ctx.setLineDash([dash, dash]);
      ctx.lineWidth   = hairline;
      ctx.strokeStyle = 'rgba(91, 138, 245, 0.85)';
      ctx.strokeRect(x + dx - pad, y + dy - pad, w + pad * 2, h + pad * 2);
      ctx.restore();
    }
    // For line/rect/circle modes the dashed overlay is replaced by the shape
    // handles themselves (no separate bounding box drawn — it's visually redundant)
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

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
 * Returns the centroid of an annotation. Handles all annotation types.
 *
 * @param {object} anno
 * @returns {{ cx: number|null, cy: number|null }}
 */
function annotationCentroid(anno) {
  if (anno.type === 'textBox' || anno.type === 'image') {
    return { cx: anno.canvasX + anno.width / 2, cy: anno.canvasY + anno.height / 2 };
  }
  if (anno.shapeType === 'circle') {
    return { cx: anno.cx, cy: anno.cy };
  }
  if ((anno.type === 'draw' || anno.type === 'highlight') && anno.points?.length) {
    let sumX = 0, sumY = 0;
    for (const p of anno.points) { sumX += p.x; sumY += p.y; }
    return { cx: sumX / anno.points.length, cy: sumY / anno.points.length };
  }
  if (anno.type === 'highlight' && anno.canvasX !== undefined) {
    return { cx: anno.canvasX + (anno.width ?? 0) / 2, cy: anno.canvasY + (anno.height ?? 0) / 2 };
  }
  return { cx: null, cy: null };
}

/**
 * Returns true if (cx, cy) is inside bounds (no padding applied here).
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
 * Returns a copy of bounds expanded by pad on all sides.
 */
function expandBounds(bounds, pad) {
  return { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 };
}

/**
 * Computes the union bounding box of a set of annotation IDs.
 * Handles all annotation types including circle shapes (cx/cy/r).
 *
 * @param {Set<string>} ids
 * @returns {{x:number, y:number, w:number, h:number}}
 */
function computeUnionBounds(ids) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const anno of getAll()) {
    if (!ids.has(anno.id)) continue;

    if (anno.shapeType === 'circle') {
      minX = Math.min(minX, anno.cx - anno.r);
      minY = Math.min(minY, anno.cy - anno.r);
      maxX = Math.max(maxX, anno.cx + anno.r);
      maxY = Math.max(maxY, anno.cy + anno.r);
    } else if (anno.type === 'textBox' || anno.type === 'image') {
      minX = Math.min(minX, anno.canvasX);
      minY = Math.min(minY, anno.canvasY);
      maxX = Math.max(maxX, anno.canvasX + anno.width);
      maxY = Math.max(maxY, anno.canvasY + anno.height);
    } else if ((anno.type === 'draw' || anno.type === 'highlight') && anno.points?.length) {
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
