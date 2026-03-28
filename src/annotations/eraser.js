/**
 * eraser.js — Eraser annotation tool
 *
 * When active, pointer-down/move over an annotation removes it.
 * The hit-test radius is generous so it works for both highlights
 * (bounding-box overlap) and draw strokes (proximity to any point).
 *
 * Uses stopImmediatePropagation on pointerdown so it doesn't conflict
 * with the canvas pan handler in input.js.
 *
 * Exports: activate(), deactivate()
 */

'use strict';

import { toCanvas }       from '../canvas/viewport.js';
import { requestRender }  from '../canvas/renderer.js';
import { getAll, remove } from './manager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default erase radius — overridden by setEraseRadius() from toolbar */
let ERASE_RADIUS = 12;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let active   = false;
let erasing  = false;
let container = null;

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
 * Converts a screen point to canvas space and removes any annotation
 * that overlaps or is within ERASE_RADIUS of that point.
 *
 * @param {number} screenX
 * @param {number} screenY
 */
function eraseAt(screenX, screenY) {
  const rect = container.getBoundingClientRect();
  const { x: cx, y: cy } = toCanvas(screenX - rect.left, screenY - rect.top);

  let changed = false;
  for (const anno of getAll()) {
    if (hitsAnnotation(anno, cx, cy)) {
      remove(anno.id);
      changed = true;
      // Only remove one annotation per erase point — prevents wiping
      // an entire stack at once. User can drag to erase more.
      break;
    }
  }

  if (changed) requestRender();
}

/**
 * Returns true if canvas point (cx, cy) hits the given annotation.
 *
 * @param {object} anno
 * @param {number} cx
 * @param {number} cy
 * @returns {boolean}
 */
function hitsAnnotation(anno, cx, cy) {
  if (anno.type === 'highlight') {
    if (anno.points) {
      // New path-based highlight — proximity check against stroke points
      for (const p of anno.points) {
        const dx = p.x - cx;
        const dy = p.y - cy;
        if (Math.sqrt(dx * dx + dy * dy) <= ERASE_RADIUS) return true;
      }
      return false;
    }
    // Legacy rect-based highlight
    const pad = 4;
    return (
      cx >= anno.canvasX - pad &&
      cx <= anno.canvasX + anno.width  + pad &&
      cy >= anno.canvasY - pad &&
      cy <= anno.canvasY + anno.height + pad
    );
  }

  if (anno.type === 'draw') {
    // Check if any segment of the stroke is within ERASE_RADIUS
    const pts = anno.points;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - cx;
      const dy = pts[i].y - cy;
      if (Math.sqrt(dx * dx + dy * dy) <= ERASE_RADIUS) return true;
    }
    return false;
  }

  if (anno.type === 'textBox') {
    return (
      cx >= anno.canvasX &&
      cx <= anno.canvasX + anno.width &&
      cy >= anno.canvasY &&
      cy <= anno.canvasY + anno.height
    );
  }

  // Images are only deletable via the select tool (delete button on the element).
  // The eraser must not remove them, even when drawing on top.
  if (anno.type === 'image') return false;

  // Blank pages are not erasable (they're canvas structure, not annotations)
  if (anno.type === 'blankPage') return false;

  return false;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initEraser, activate, deactivate, setEraseRadius };
