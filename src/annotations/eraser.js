/**
 * eraser.js — Eraser annotation tool
 *
 * Two erase behaviours depending on annotation type:
 *
 *   draw / highlight (path-based)
 *   ─────────────────────────────
 *   Partial erase: the eraser circle punches a hole in the stroke. Points
 *   within ERASE_RADIUS are removed; the remaining point runs are saved as
 *   separate new annotations. If the circle only crosses a segment (no points
 *   fall inside), the stroke is split at that segment boundary.
 *
 *   textBox
 *   ───────
 *   Whole-annotation removal (bounding-box hit).
 *
 *   image / blankPage
 *   ─────────────────
 *   Not erasable (handled by select tool / page manager).
 *
 * Uses stopImmediatePropagation on pointerdown so it doesn't conflict
 * with the canvas pan handler in input.js.
 *
 * Exports: initEraser(), activate(), deactivate(), setEraseRadius()
 */

'use strict';

import { toCanvas, state as viewportState } from '../canvas/viewport.js';
import { requestRender }                   from '../canvas/renderer.js';
import { getAll, remove, add, beginUndoGroup, endUndoGroup } from './manager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default erase radius — overridden by setEraseRadius() from toolbar */
let ERASE_RADIUS = 12;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let active    = false;
let erasing   = false;
let container = null;

/** 'partial' — splits strokes; 'full' — removes whole annotations */
let eraseMode = 'partial';

/** When true, the erase radius is fixed in screen pixels regardless of zoom level */
let lukasExtra = false;

/** The on-canvas ring overlay element that visualises the erase radius */
let ringEl = null;

/** When true the ring is shown as a size preview below the slider popover, not following cursor */
let previewMode = false;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Must be called once after the DOM is ready.
 * Attaches listeners (passive — only fires when active).
 */
function init() {
  container = document.getElementById('canvas-container');
  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup',   onPointerUp);
  container.addEventListener('pointercancel', onPointerUp);

  // Build the size-ring overlay element (follows pointer when eraser active)
  ringEl = document.createElement('div');
  ringEl.id = 'eraser-ring';
  document.body.appendChild(ringEl);

  // Re-size the ring when zoom changes — lukasExtra stays fixed in screen pixels
  container.addEventListener('viewport-changed', () => {
    if (!active || !ringEl) return;
    const diameterPx = _ringDiameter();
    ringEl.style.width  = `${diameterPx}px`;
    ringEl.style.height = `${diameterPx}px`;
  });
}

function activate() {
  active = true;
  container.classList.add('tool-eraser');
  // Hide the CSS cursor so the ring overlay replaces it
  container.style.cursor = 'none';
  if (ringEl) ringEl.classList.add('visible');
}

function deactivate() {
  active  = false;
  erasing = false;
  container.classList.remove('tool-eraser');
  container.style.cursor = '';
  if (ringEl) ringEl.classList.remove('visible');
}

/**
 * Ring diameter in screen pixels.
 * lukasExtra: fixed screen-pixel size (no scale).
 * partial/full: canvas radius scaled to screen pixels.
 */
/**
 * Ring diameter in screen pixels.
 * lukasExtra: fixed screen-pixel size (no scale).
 * normal: canvas radius scaled to screen pixels.
 */
function _ringDiameter() {
  return lukasExtra
    ? ERASE_RADIUS * 2
    : ERASE_RADIUS * 2 * viewportState.scale;
}

/**
 * Effective erase radius in canvas units used for hit detection.
 * lukasExtra: converts fixed screen-pixel radius to canvas units at current zoom.
 * normal: ERASE_RADIUS is already in canvas units.
 */
function _effectiveCanvasRadius() {
  return lukasExtra
    ? ERASE_RADIUS / viewportState.scale
    : ERASE_RADIUS;
}

/** Moves and sizes the ring overlay to match the current pointer position. */
function _updateRing(clientX, clientY) {
  if (!ringEl || previewMode) return;
  const diameterPx = _ringDiameter();
  ringEl.style.width  = `${diameterPx}px`;
  ringEl.style.height = `${diameterPx}px`;
  ringEl.style.left   = `${clientX}px`;
  ringEl.style.top    = `${clientY}px`;
}

/**
 * Shows the ring at a fixed screen position as a size preview (e.g. below the
 * size slider popover). Does not require the eraser tool to be active.
 * Call hideSizePreview() to dismiss.
 */
function showSizePreview(screenX, screenY) {
  if (!ringEl) return;
  previewMode = true;
  const diameterPx = _ringDiameter();
  ringEl.style.width  = `${diameterPx}px`;
  ringEl.style.height = `${diameterPx}px`;
  ringEl.style.left   = `${screenX}px`;
  ringEl.style.top    = `${screenY}px`;
  ringEl.classList.add('visible');
}

/** Hides the preview ring. If the eraser tool is active it stays visible (cursor-following). */
function hideSizePreview() {
  previewMode = false;
  if (!active && ringEl) ringEl.classList.remove('visible');
}

/**
 * Sets the erase radius (canvas units). Called by toolbar when the user picks
 * a different eraser size.
 * @param {number} radius
 */
function setEraseRadius(radius) {
  ERASE_RADIUS = radius;
  if (!ringEl) return;
  if (active || previewMode) {
    const diameterPx = _ringDiameter();
    ringEl.style.width  = `${diameterPx}px`;
    ringEl.style.height = `${diameterPx}px`;
  }
}

/**
 * Sets the erase mode. 'partial' splits strokes at the eraser circle;
 * 'full' removes the entire annotation on any hit.
 * @param {'partial'|'full'} mode
 */
function setEraseMode(mode) {
  eraseMode = mode;
}

/**
 * Toggles Lukas' Extra — when true, the erase radius is fixed in screen pixels
 * regardless of zoom level. Works alongside partial and full modes.
 * @param {boolean} enabled
 */
function setLukasExtra(enabled) {
  lukasExtra = enabled;
  if (!ringEl) return;
  if (active || previewMode) {
    const diameterPx = _ringDiameter();
    ringEl.style.width  = `${diameterPx}px`;
    ringEl.style.height = `${diameterPx}px`;
  }
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  if (!active) return;
  if (e.pointerType === 'touch') return;
  e.stopImmediatePropagation();
  erasing = true;
  _updateRing(e.clientX, e.clientY);
  // Open a group so every remove/add during this stroke is one undo step
  beginUndoGroup();
  eraseAt(e.clientX, e.clientY);
}

function onPointerMove(e) {
  if (!active) return;
  if (e.pointerType === 'touch') return;
  _updateRing(e.clientX, e.clientY);
  if (!erasing) return;
  e.stopImmediatePropagation();
  eraseAt(e.clientX, e.clientY);
}

function onPointerUp() {
  erasing = false;
  // Close the group — all annotations touched in this stroke undo as one action
  endUndoGroup();
}

// ---------------------------------------------------------------------------
// Erase logic
// ---------------------------------------------------------------------------

/**
 * Converts a screen point to canvas space and erases the first annotation
 * found at that point. Path-based annotations (draw/highlight) are split
 * rather than removed entirely.
 *
 * @param {number} screenX
 * @param {number} screenY
 */
function eraseAt(screenX, screenY) {
  const rect = container.getBoundingClientRect();
  const { x: cx, y: cy } = toCanvas(screenX - rect.left, screenY - rect.top);
  const r = _effectiveCanvasRadius();

  for (const anno of getAll()) {
    if (anno.type === 'textBox' || anno.type === 'image') continue;

    if ((anno.type === 'draw' || (anno.type === 'highlight' && anno.points)) &&
        strokeHitsEraser(anno.points, cx, cy, r)) {
      if (eraseMode === 'partial') {
        splitAndReplace(anno, cx, cy, r);
      } else {
        remove(anno.id);
      }
      requestRender();
      return;
    }

    if (anno.type === 'highlight' && !anno.points) {
      const pad = 4;
      if (cx >= anno.canvasX - pad && cx <= anno.canvasX + anno.width  + pad &&
          cy >= anno.canvasY - pad && cy <= anno.canvasY + anno.height + pad) {
        remove(anno.id);
        requestRender();
        return;
      }
    }

    if (anno.type === 'draw' && anno.shapeType === 'circle') {
      const dist = Math.sqrt((cx - anno.cx) ** 2 + (cy - anno.cy) ** 2);
      if (Math.abs(dist - anno.r) <= r) {
        remove(anno.id);
        requestRender();
        return;
      }
    }

    if (anno.type === 'draw' && anno.shapeType === 'ellipse') {
      const nx   = (cx - anno.cx) / anno.rx;
      const ny   = (cy - anno.cy) / anno.ry;
      const norm = Math.sqrt(nx * nx + ny * ny);
      const minAxis = Math.min(anno.rx, anno.ry);
      if (Math.abs(norm - 1.0) <= r / minAxis) {
        remove(anno.id);
        requestRender();
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stroke hit detection (segment-aware)
// ---------------------------------------------------------------------------

/**
 * Returns true if the eraser circle (centre cx/cy, radius ERASE_RADIUS) overlaps
 * the stroke defined by points[]. Uses segment-to-point distance so the eraser
 * reliably hits strokes even when the circle centre falls between two recorded
 * points on a long, fast segment.
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {number} cx
 * @param {number} cy
 * @returns {boolean}
 */
function strokeHitsEraser(points, cx, cy, r) {
  if (points.length === 0) return false;

  const fp = points[0];
  if ((fp.x - cx) ** 2 + (fp.y - cy) ** 2 <= r ** 2) return true;

  for (let i = 0; i < points.length - 1; i++) {
    if (distToSegment(points[i], points[i + 1], cx, cy) <= r) return true;
  }
  return false;
}

/**
 * Minimum distance from point (cx, cy) to the line segment (p1, p2).
 *
 * @param {{x:number,y:number}} p1
 * @param {{x:number,y:number}} p2
 * @param {number} cx
 * @param {number} cy
 * @returns {number}
 */
function distToSegment(p1, p2, cx, cy) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    // Degenerate segment (p1 === p2) — treat as point
    const ex = p1.x - cx, ey = p1.y - cy;
    return Math.sqrt(ex * ex + ey * ey);
  }

  const t = Math.max(0, Math.min(1,
    ((cx - p1.x) * dx + (cy - p1.y) * dy) / lenSq
  ));
  const projX = p1.x + t * dx - cx;
  const projY = p1.y + t * dy - cy;
  return Math.sqrt(projX * projX + projY * projY);
}

// ---------------------------------------------------------------------------
// Stroke splitting
// ---------------------------------------------------------------------------

/**
 * Punches a hole in a path-based annotation at (cx, cy) and saves the
 * surviving pieces as new annotations.
 *
 * Algorithm:
 *   1. Walk the points array. Points within ERASE_RADIUS are discarded; the
 *      rest are collected into contiguous "segments".
 *   2. If no points were discarded (eraser crossed a segment mid-span), find
 *      the first crossed segment and split there, keeping both sides.
 *   3. Remove the original annotation. Add each surviving segment (≥2 points)
 *      as a fresh annotation inheriting all style properties.
 *
 * Undo: removing the original + adding fragments each push to the undo stack
 * independently, so Ctrl+Z pressed multiple times fully reverses the erase.
 *
 * @param {object} anno  — The annotation to split
 * @param {number} cx    — Eraser centre in canvas space
 * @param {number} cy
 */
function splitAndReplace(anno, cx, cy, r) {
  const r2  = r * r;
  const pts = anno.points;

  // ── Step 1: collect segments by filtering out points inside the eraser ──
  const segments = [];
  let current    = [];

  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy;
    if (dx * dx + dy * dy <= r2) {
      // Inside eraser — end the current segment
      if (current.length >= 2) segments.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length >= 2) segments.push(current);

  // ── Step 2: if no points were inside the circle, the eraser only crossed
  //    a segment. Find the first such segment and split at its boundary. ──
  if (segments.length === 1 && segments[0].length === pts.length) {
    for (let i = 0; i < pts.length - 1; i++) {
      if (distToSegment(pts[i], pts[i + 1], cx, cy) <= r) {
        const left  = pts.slice(0, i + 1);
        const right = pts.slice(i + 1);
        remove(anno.id);
        if (left.length  >= 2) add(stripMeta(anno, left));
        if (right.length >= 2) add(stripMeta(anno, right));
        return;
      }
    }
  }

  // ── Step 3: remove original and re-add surviving segments ──────────────
  remove(anno.id);
  for (const seg of segments) {
    add(stripMeta(anno, seg));
  }
}

/**
 * Returns a copy of an annotation with the points replaced and the id /
 * timestamp fields stripped so manager.add() assigns fresh ones.
 *
 * @param {object} anno
 * @param {Array}  newPoints
 * @returns {object}
 */
function stripMeta(anno, newPoints) {
  const { id, createdAt, updatedAt, ...rest } = anno;
  return { ...rest, points: newPoints };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initEraser, activate, deactivate, setEraseRadius, setEraseMode, setLukasExtra, showSizePreview, hideSizePreview };
