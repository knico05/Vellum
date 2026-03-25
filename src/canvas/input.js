/**
 * input.js — Mouse, keyboard, and pointer input on the infinite canvas
 *
 * Handles four interaction modes:
 *
 *   Pan   — Middle-mouse drag OR Space + left-drag
 *           Moves the viewport by the drag delta in screen pixels.
 *
 *   Zoom  — Scroll wheel (toward cursor)
 *           Ctrl + scroll (trackpad pinch, same handling)
 *           Keyboard +/- (toward canvas centre)
 *
 * After each viewport change, fires a 'viewport-changed' CustomEvent on
 * #canvas-container so other modules (PDF renderer, annotation overlays)
 * can react.
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

/** True while the spacebar is held down (pan mode) */
let spaceDown = false;

/** True while a pan drag is in progress */
let isPanning = false;

/** Screen position where the current drag started */
let dragStartX = 0;
let dragStartY = 0;

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

  // Mouse
  container.addEventListener('mousedown',  onMouseDown);
  container.addEventListener('mousemove',  onMouseMove);
  container.addEventListener('mouseup',    onMouseUp);
  container.addEventListener('mouseleave', onMouseLeave);
  container.addEventListener('wheel',      onWheel, { passive: false });

  // Keyboard (attached to window so it works regardless of focus)
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup',   onKeyUp);

  // Prevent context menu on right-click (we may use right-click for tools later)
  container.addEventListener('contextmenu', e => e.preventDefault());
}

// ---------------------------------------------------------------------------
// Pan — mouse drag
// ---------------------------------------------------------------------------

function onMouseDown(e) {
  // Middle mouse button (button 1) always pans
  // Left mouse button (button 0) only pans when space is held
  const isMiddle = e.button === 1;
  const isSpacePan = e.button === 0 && spaceDown;

  if (isMiddle || isSpacePan) {
    startPan(e.clientX, e.clientY);
    e.preventDefault();
  }
}

function onMouseMove(e) {
  if (!isPanning) return;

  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;

  applyPan(dx, dy);
  requestRender();
  emitViewportChanged();

  // Update start position for the next move delta
  dragStartX = e.clientX;
  dragStartY = e.clientY;
}

function onMouseUp(e) {
  if (isPanning) {
    stopPan();
  }
}

function onMouseLeave() {
  // Stop panning if the cursor leaves the canvas area
  if (isPanning) {
    stopPan();
  }
}

function startPan(x, y) {
  isPanning  = true;
  dragStartX = x;
  dragStartY = y;
  container.style.cursor = 'grabbing';
}

function stopPan() {
  isPanning = false;
  // Restore cursor: grab if space still held, default otherwise
  container.style.cursor = spaceDown ? 'grab' : '';
}

// ---------------------------------------------------------------------------
// Zoom — scroll wheel
// ---------------------------------------------------------------------------

function onWheel(e) {
  e.preventDefault(); // Prevent page scroll

  // Determine the container-relative position of the cursor
  const rect = container.getBoundingClientRect();
  const originX = e.clientX - rect.left;
  const originY = e.clientY - rect.top;

  // Ctrl key (or pinch on trackpad which sets ctrlKey=true) → zoom
  // Plain scroll → zoom (common convention for canvas tools like Figma)
  // Shift + scroll → horizontal pan
  if (e.shiftKey && !e.ctrlKey) {
    // Horizontal pan
    applyPan(-e.deltaY, 0);
  } else {
    // Zoom toward cursor
    // deltaY is positive when scrolling down (zoom out), negative for up (zoom in)
    // We negate it so scrolling up zooms in.
    const delta = -e.deltaY * ZOOM_FACTOR * SCROLL_ZOOM_SENSITIVITY;
    applyZoom(delta, originX, originY);
  }

  requestRender();
  emitViewportChanged();
}

// ---------------------------------------------------------------------------
// Zoom — keyboard
// ---------------------------------------------------------------------------

function onKeyDown(e) {
  // Ignore if focus is in an input/textarea/contenteditable
  if (isEditableTarget(e.target)) return;

  const rect = container.getBoundingClientRect();
  // Keyboard zoom is toward the centre of the canvas
  const centreX = rect.width  / 2;
  const centreY = rect.height / 2;

  switch (e.key) {
    case ' ':
      // Space = pan mode
      if (!e.repeat) {
        spaceDown = true;
        container.style.cursor = 'grab';
      }
      // Prevent page scroll from spacebar
      e.preventDefault();
      break;

    case '+':
    case '=': // = is the un-shifted + on most keyboards
      applyZoom(KEYBOARD_ZOOM_STEP, centreX, centreY);
      requestRender();
      emitViewportChanged();
      e.preventDefault();
      break;

    case '-':
      applyZoom(-KEYBOARD_ZOOM_STEP, centreX, centreY);
      requestRender();
      emitViewportChanged();
      e.preventDefault();
      break;

    case '0':
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+0 — reset to 100% zoom, pan back to origin
        reset();
        requestRender();
        emitViewportChanged();
        e.preventDefault();
      }
      break;
  }
}

function onKeyUp(e) {
  if (e.key === ' ') {
    spaceDown = false;
    if (!isPanning) {
      container.style.cursor = '';
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the event target is an element where keyboard input
 * should take precedence over canvas shortcuts.
 *
 * @param {EventTarget} target
 * @returns {boolean}
 */
function isEditableTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    target.isContentEditable
  );
}

/**
 * Dispatches a 'viewport-changed' CustomEvent on the container.
 * Other modules (PDF page renderer, annotation overlays) listen to this
 * to know when to reposition their content.
 */
function emitViewportChanged() {
  container.dispatchEvent(new CustomEvent('viewport-changed', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init };
