/**
 * input.js — Mouse, touch, pen, and keyboard input on the infinite canvas
 *
 * Uses the Pointer Events API so the same code handles mouse, touch, and
 * stylus without special-casing. Native touch events are only used for
 * pinch-to-zoom (two simultaneous pointers).
 *
 * Interaction model:
 *
 *   Touch (fingers)
 *   ───────────────
 *   1 finger drag          → pan
 *   2 finger pinch         → zoom toward pinch midpoint
 *
 *   Mouse
 *   ─────
 *   Middle-button drag     → pan
 *   Space + left drag      → pan
 *   Scroll wheel           → zoom toward cursor
 *   Shift + scroll         → horizontal pan
 *   Ctrl + scroll (pinch)  → zoom toward cursor (trackpad)
 *
 *   Pen / stylus
 *   ────────────
 *   Completely ignored here — pen is exclusively for annotation tools
 *   (draw, highlight, eraser, select). Panning is done with fingers.
 *
 *   Keyboard
 *   ────────
 *   + / -                  → zoom toward canvas centre
 *   Ctrl+0                 → reset viewport
 *
 * When annotation tools are added in Phase 4, a single-pointer drag will
 * annotate instead of pan. Two-finger drag will always pan regardless of
 * the active tool.
 *
 * After every viewport change, fires 'viewport-changed' CustomEvent on
 * #canvas-container so downstream modules can reposition their content.
 *
 * Exports: init()
 */

'use strict';

import { applyZoom, applyPan, reset, ZOOM_FACTOR } from './viewport.js';
import { requestRender } from './renderer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How much to zoom per keyboard +/- press */
const KEYBOARD_ZOOM_STEP = 0.15;

/** Scroll wheel pixels → zoom delta multiplier */
const SCROLL_ZOOM_SENSITIVITY = 0.8;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** True while the spacebar is held down */
let spaceDown = false;

/**
 * All currently active pointers, keyed by pointerId.
 * Each entry: { x, y } in container-relative coordinates.
 */
const activePointers = new Map();

/**
 * Distance between the two touch points at the start of the current pinch.
 * Updated each move event so we can compute the incremental zoom factor.
 */
let lastPinchDistance = 0;

/** The container element we listen on */
let container = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Attaches all input event listeners to #canvas-container.
 * Must be called once after the DOM is ready.
 */
function init() {
  container = document.getElementById('canvas-container');

  // Pointer events handle mouse, touch, and pen uniformly
  container.addEventListener('pointerdown',   onPointerDown);
  container.addEventListener('pointermove',   onPointerMove);
  container.addEventListener('pointerup',     onPointerEnd);
  container.addEventListener('pointercancel', onPointerEnd);

  // Scroll wheel (mouse zoom + trackpad pinch)
  container.addEventListener('wheel', onWheel, { passive: false });

  // Keyboard
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup',   onKeyUp);

  // Suppress browser context menu — we may use right-click for tools later
  container.addEventListener('contextmenu', e => e.preventDefault());

  // Prevent browser default touch actions (scroll, pinch-zoom the page)
  // so our canvas gestures take over.
  container.style.touchAction = 'none';
}

// ---------------------------------------------------------------------------
// Pointer down
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  // Pen is handled exclusively by annotation tools — never pan with pen.
  // Letting input.js capture pen pointers would prevent draw.js / highlight.js
  // from receiving clean events, making it impossible to annotate.
  if (e.pointerType === 'pen') return;

  // Capture the pointer so we keep receiving events even if the cursor
  // leaves the container element during a fast drag.
  container.setPointerCapture(e.pointerId);

  activePointers.set(e.pointerId, pointerPos(e));

  if (activePointers.size === 2) {
    // Second finger down — initialise pinch distance
    lastPinchDistance = getPinchDistance();
  }

  e.preventDefault();
}

// ---------------------------------------------------------------------------
// Pointer move
// ---------------------------------------------------------------------------

function onPointerMove(e) {
  if (!activePointers.has(e.pointerId)) return;

  const prev = activePointers.get(e.pointerId);
  const curr = pointerPos(e);
  activePointers.set(e.pointerId, curr);

  if (activePointers.size === 1) {
    // ── Single pointer ───────────────────────────────────────────────────
    // Touch/pen: always pan.
    // Mouse: pan only when middle button or space is held.
    const isMouse = e.pointerType === 'mouse';
    const isMiddle = isMouse && e.buttons === 4; // middle button bitmask
    const isSpacePan = isMouse && spaceDown && (e.buttons & 1); // left + space

    if (!isMouse || isMiddle || isSpacePan) {
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      applyPan(dx, dy);
      emitAndRender();
    }

  } else if (activePointers.size === 2) {
    // ── Pinch (two-finger zoom + pan) ────────────────────────────────────
    const newDistance = getPinchDistance();

    if (lastPinchDistance > 0) {
      // Zoom: ratio of new distance to previous distance
      const zoomFactor = newDistance / lastPinchDistance - 1;
      const mid = getPinchMidpoint();
      applyZoom(zoomFactor, mid.x, mid.y);
    }

    lastPinchDistance = newDistance;
    emitAndRender();
  }
}

// ---------------------------------------------------------------------------
// Pointer up / cancel
// ---------------------------------------------------------------------------

function onPointerEnd(e) {
  activePointers.delete(e.pointerId);
  lastPinchDistance = 0;

  if (activePointers.size === 0 && !spaceDown) {
    container.style.cursor = '';
  }
}

// ---------------------------------------------------------------------------
// Scroll wheel (mouse zoom + trackpad pinch)
// ---------------------------------------------------------------------------

function onWheel(e) {
  e.preventDefault();

  const rect = container.getBoundingClientRect();
  const originX = e.clientX - rect.left;
  const originY = e.clientY - rect.top;

  if (e.ctrlKey) {
    // Ctrl+scroll or trackpad pinch → zoom toward cursor
    // Negate deltaY: scrolling up (negative delta) = zoom in (positive factor)
    const delta = -e.deltaY * ZOOM_FACTOR * SCROLL_ZOOM_SENSITIVITY;
    applyZoom(delta, originX, originY);
  } else if (e.shiftKey) {
    // Shift+scroll → horizontal pan
    applyPan(-e.deltaY, 0);
  } else {
    // Plain scroll → vertical pan
    applyPan(0, -e.deltaY);
  }

  emitAndRender();
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

function onKeyDown(e) {
  if (isEditableTarget(e.target)) return;

  const rect = container.getBoundingClientRect();
  const centreX = rect.width  / 2;
  const centreY = rect.height / 2;

  switch (e.key) {
    case ' ':
      if (!e.repeat) {
        spaceDown = true;
        container.style.cursor = 'grab';
      }
      e.preventDefault(); // Stop page scroll
      break;

    case '+':
    case '=':
      applyZoom(KEYBOARD_ZOOM_STEP, centreX, centreY);
      emitAndRender();
      e.preventDefault();
      break;

    case '-':
      applyZoom(-KEYBOARD_ZOOM_STEP, centreX, centreY);
      emitAndRender();
      e.preventDefault();
      break;

    case '0':
      if (e.ctrlKey || e.metaKey) {
        reset();
        emitAndRender();
        e.preventDefault();
      }
      break;
  }
}

function onKeyUp(e) {
  if (e.key === ' ') {
    spaceDown = false;
    if (activePointers.size === 0) {
      container.style.cursor = '';
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns container-relative {x, y} for a pointer event.
 * @param {PointerEvent} e
 * @returns {{ x: number, y: number }}
 */
function pointerPos(e) {
  const rect = container.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/**
 * Euclidean distance between the two currently active pointers.
 * Only valid when activePointers.size === 2.
 * @returns {number}
 */
function getPinchDistance() {
  const [p1, p2] = activePointers.values();
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Midpoint between the two currently active pointers, in container coords.
 * Only valid when activePointers.size === 2.
 * @returns {{ x: number, y: number }}
 */
function getPinchMidpoint() {
  const [p1, p2] = activePointers.values();
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}

/**
 * Returns true if the event target is an element where keyboard input
 * should take precedence over canvas shortcuts.
 * @param {EventTarget} target
 * @returns {boolean}
 */
function isEditableTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/**
 * Requests a canvas redraw and dispatches 'viewport-changed' so downstream
 * modules (PDF pages, annotation overlays) can reposition their content.
 */
function emitAndRender() {
  requestRender();
  container.dispatchEvent(new CustomEvent('viewport-changed', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init };
