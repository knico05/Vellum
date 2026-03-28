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

import { toCanvas }              from '../canvas/viewport.js';
import { requestRender }         from '../canvas/renderer.js';
import { getAll, remove, add }   from './manager.js';

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
}

function activate() {
  active = true;
  container.classList.add('tool-eraser');
}

function deactivate() {
  active  = false;
  erasing = false;
  container.classList.remove('tool-eraser');
}

/**
 * Sets the erase radius (canvas units). Called by toolbar when the user picks
 * a different eraser size.
 * @param {number} radius
 */
function setEraseRadius(radius) {
  ERASE_RADIUS = radius;
}

/**
 * Sets the erase mode. 'partial' splits strokes at the eraser circle;
 * 'full' removes the entire annotation on any hit.
 * @param {'partial'|'full'} mode
 */
function setEraseMode(mode) {
  eraseMode = mode;
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  if (!active) return;
  if (e.pointerType === 'touch') return;
  e.stopImmediatePropagation();
  erasing = true;
  eraseAt(e.clientX, e.clientY);
}

function onPointerMove(e) {
  if (!active || !erasing) return;
  if (e.pointerType === 'touch') return;
  e.stopImmediatePropagation();
  eraseAt(e.clientX, e.clientY);
}

function onPointerUp() {
  erasing = false;
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

  for (const anno of getAll()) {
    // Path-based strokes: partial or full erase depending on mode
    if ((anno.type === 'draw' || (anno.type === 'highlight' && anno.points)) &&
        strokeHitsEraser(anno.points, cx, cy)) {
      if (eraseMode === 'partial') {
        splitAndReplace(anno, cx, cy);
      } else {
        remove(anno.id);
      }
      requestRender();
      return;
    }

    // Legacy rect-based highlight: whole-annotation removal
    if (anno.type === 'highlight' && !anno.points) {
      const pad = 4;
      if (cx >= anno.canvasX - pad && cx <= anno.canvasX + anno.width  + pad &&
          cy >= anno.canvasY - pad && cy <= anno.canvasY + anno.height + pad) {
        remove(anno.id);
        requestRender();
        return;
      }
    }

    // Text boxes: whole-annotation removal on bounding-box hit
    if (anno.type === 'textBox' &&
        cx >= anno.canvasX && cx <= anno.canvasX + anno.width &&
        cy >= anno.canvasY && cy <= anno.canvasY + anno.height) {
      remove(anno.id);
      requestRender();
      return;
    }

    // Images: not erasable (use select tool → delete button)
    // Blank pages: not erasable (canvas structure)
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
function strokeHitsEraser(points, cx, cy) {
  if (points.length === 0) return false;

  // Check first point in isolation (covers single-point degenerate strokes)
  const fp = points[0];
  if ((fp.x - cx) ** 2 + (fp.y - cy) ** 2 <= ERASE_RADIUS ** 2) return true;

  for (let i = 0; i < points.length - 1; i++) {
    if (distToSegment(points[i], points[i + 1], cx, cy) <= ERASE_RADIUS) return true;
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
function splitAndReplace(anno, cx, cy) {
  const r2  = ERASE_RADIUS * ERASE_RADIUS;
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
      if (distToSegment(pts[i], pts[i + 1], cx, cy) <= ERASE_RADIUS) {
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

export { init as initEraser, activate, deactivate, setEraseRadius, setEraseMode };
