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

import { applyZoom, applyPan, reset, ZOOM_FACTOR, state as viewportState } from './viewport.js';
import { requestRender, enterDeferredMode, exitDeferredMode } from './renderer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How much to zoom per keyboard +/- press */
const KEYBOARD_ZOOM_STEP = 0.15;

/**
 * Zoom sensitivity for trackpad pinch gestures (ctrlKey + wheel, small deltaY).
 * Trackpad pinch sends tiny deltas (~1–10px per event) so needs higher sensitivity
 * than a mouse wheel which sends large deltas (~100–120px per click).
 */
const PINCH_ZOOM_SENSITIVITY = 6.0;

/**
 * Zoom sensitivity for Ctrl + mouse wheel (large deltaY ≥ 20px per click).
 * Kept at 1.0 so one wheel click = ~10–12% zoom, consistent with browser behaviour.
 */
const WHEEL_ZOOM_SENSITIVITY = 1.0;

/**
 * Viewport scale below which the user is in "overview" mode (many pages visible).
 * Momentum lasts longer in overview mode so rapid page-flicking feels natural.
 */
const OVERVIEW_SCALE_THRESHOLD = 0.8;

/** Friction applied per animation frame in overview mode (0.96 → ~1.5s coast) */
const FRICTION_OVERVIEW = 0.96;

/** Friction applied per animation frame in reading mode (0.92 → ~0.8s coast) */
const FRICTION_READING = 0.92;

/** Velocity (px/frame) below which the momentum animation stops */
const MIN_VELOCITY = 0.5;

/** ms after the last wheel event before momentum kicks in */
const WHEEL_END_DELAY_MS = 50;

/**
 * Exponential moving-average factor for velocity smoothing.
 * 0.6 = retain 60% old velocity, take 40% of the latest delta.
 * Higher = smoother but slower to track direction changes.
 */
const VELOCITY_SMOOTHING = 0.6;

/**
 * How long (ms) to continue suppressing touch events after the last pen lift.
 * Covers the typical wrist-lift delay so a slow-moving palm doesn't immediately
 * trigger a pan the moment the stylus leaves the screen.
 */
const PALM_REJECTION_GRACE_MS = 200;

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
// Palm rejection state
// ---------------------------------------------------------------------------

/**
 * Set of pointer IDs belonging to active pen contacts.
 * While non-empty, touch events are ignored so the palm/wrist cannot
 * accidentally trigger a pan while the user is writing.
 */
const activePenPointers = new Set();

/**
 * True while a pen is down OR during the post-lift grace period.
 * Checked in onPointerDown to gate touch events.
 */
let palmRejectionActive = false;

/** setTimeout handle for the post-pen-lift grace period */
let palmRejectionTimer = null;

/** Current momentum velocity in screen pixels per animation frame */
let velX = 0;
let velY = 0;

/** requestAnimationFrame handle for an active momentum animation, or null */
let momentumRafId = null;

/** setTimeout handle used to detect when trackpad scrolling has stopped */
let wheelEndTimer = null;

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

  // Track pen lift anywhere on the window so palm rejection clears even if
  // the stylus leaves the canvas while lifting.
  window.addEventListener('pointerup', onWindowPenUp);
  window.addEventListener('pointercancel', onWindowPenCancel);
}

// ---------------------------------------------------------------------------
// Pointer down
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  // Pen is handled exclusively by annotation tools — never pan with pen.
  // Also register the pen contact so palm rejection can suppress touch events
  // while the stylus is on screen.
  if (e.pointerType === 'pen') {
    activePenPointers.add(e.pointerId);
    palmRejectionActive = true;
    clearTimeout(palmRejectionTimer);
    return;
  }

  // Palm rejection: ignore touch while the pen is in contact or during the
  // short grace period after the pen lifts. This prevents the wrist from
  // accidentally panning the canvas while writing.
  if (e.pointerType === 'touch' && palmRejectionActive) return;

  // A new touch cancels any in-flight momentum so the user regains control.
  stopMomentum();

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

      // Track velocity using EMA so pointer lift launches momentum
      velX = velX * VELOCITY_SMOOTHING + dx * (1 - VELOCITY_SMOOTHING);
      velY = velY * VELOCITY_SMOOTHING + dy * (1 - VELOCITY_SMOOTHING);

      applyPan(dx, dy);
      enterDeferredMode();
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
      enterDeferredMode();
    }

    lastPinchDistance = newDistance;
    emitAndRender();
  }
}

// ---------------------------------------------------------------------------
// Pointer up / cancel
// ---------------------------------------------------------------------------

function onPointerEnd(e) {
  // Pen lifts are handled by the window-level listeners (onWindowPenUp/Cancel)
  // so that palm rejection clears even if the pen leaves the container.
  if (e.pointerType === 'pen') return;

  activePointers.delete(e.pointerId);
  lastPinchDistance = 0;

  if (activePointers.size === 0) {
    // Always launch momentum on finger lift — friction decides how long it coasts.
    // Overview mode (zoomed out): low friction = long glide for page-flicking.
    // Reading mode (zoomed in): high friction = stops quickly, feels precise.
    startMomentum();

    if (!spaceDown) container.style.cursor = '';
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
    // Ctrl+scroll or trackpad pinch → zoom toward cursor.
    // Trackpad pinch sends tiny deltaY (1–10px); mouse wheel sends large values
    // (~100–120px). Use different sensitivities so both feel equally responsive.
    stopMomentum();
    const isPinch   = Math.abs(e.deltaY) < 20;
    const sens      = isPinch ? PINCH_ZOOM_SENSITIVITY : WHEEL_ZOOM_SENSITIVITY;
    const delta     = -e.deltaY * ZOOM_FACTOR * sens;
    applyZoom(delta, originX, originY);
    enterDeferredMode();
    clearTimeout(wheelEndTimer);
    wheelEndTimer = setTimeout(startMomentum, WHEEL_END_DELAY_MS);
  } else {
    // Pan: trackpad sends both deltaX and deltaY naturally.
    // Shift+wheel maps the single-axis wheel delta to horizontal for mouse users.
    const dx = e.shiftKey ? -e.deltaY : -e.deltaX;
    const dy = e.shiftKey ?          0 : -e.deltaY;

    // Track scroll velocity for momentum
    velX = velX * VELOCITY_SMOOTHING + dx * (1 - VELOCITY_SMOOTHING);
    velY = velY * VELOCITY_SMOOTHING + dy * (1 - VELOCITY_SMOOTHING);

    applyPan(dx, dy);
    enterDeferredMode();

    // Momentum: wait for scrolling to stop, then coast
    clearTimeout(wheelEndTimer);
    wheelEndTimer = setTimeout(startMomentum, WHEEL_END_DELAY_MS);
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
 * Starts a momentum animation that continues scrolling after the user lifts
 * their finger or stops swiping on the trackpad.
 *
 * Friction is lower in overview mode (zoomed out, navigating pages) so the
 * canvas coasts further. In reading mode (zoomed in) friction is higher so
 * the canvas stops quickly and feels precise.
 *
 * Only launched when velocity is above MIN_VELOCITY; otherwise no-ops.
 */
function startMomentum() {
  cancelAnimationFrame(momentumRafId);

  if (Math.abs(velX) < MIN_VELOCITY && Math.abs(velY) < MIN_VELOCITY) {
    velX = 0;
    velY = 0;
    exitDeferredMode(); // No momentum — pan is done, rebuild annotation canvas now
    return;
  }

  const friction = viewportState.scale < OVERVIEW_SCALE_THRESHOLD
    ? FRICTION_OVERVIEW
    : FRICTION_READING;

  function step() {
    velX *= friction;
    velY *= friction;

    if (Math.abs(velX) < MIN_VELOCITY && Math.abs(velY) < MIN_VELOCITY) {
      velX = 0;
      velY = 0;
      exitDeferredMode(); // Momentum fully coasted out — rebuild annotation canvas
      return;
    }

    applyPan(velX, velY);
    emitAndRender();
    momentumRafId = requestAnimationFrame(step);
  }

  momentumRafId = requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// Palm rejection helpers
// ---------------------------------------------------------------------------

/**
 * Called when any pen pointer is lifted, anywhere on the window.
 * Starts the grace period: touch events remain blocked for PALM_REJECTION_GRACE_MS
 * after the last pen contact ends, covering the typical wrist-lift delay.
 */
function onWindowPenUp(e) {
  if (e.pointerType !== 'pen') return;
  activePenPointers.delete(e.pointerId);
  if (activePenPointers.size === 0) {
    palmRejectionTimer = setTimeout(() => {
      palmRejectionActive = false;
    }, PALM_REJECTION_GRACE_MS);
  }
}

/**
 * Called when a pen contact is cancelled (e.g. palm rejection by the OS,
 * app switching). Clears immediately without a grace period.
 */
function onWindowPenCancel(e) {
  if (e.pointerType !== 'pen') return;
  activePenPointers.delete(e.pointerId);
  if (activePenPointers.size === 0) {
    clearTimeout(palmRejectionTimer);
    palmRejectionActive = false;
  }
}

/**
 * Cancels any active momentum animation and clears velocity state.
 * Call this when the user initiates a new gesture.
 */
function stopMomentum() {
  cancelAnimationFrame(momentumRafId);
  clearTimeout(wheelEndTimer);
  momentumRafId = null;
  velX = 0;
  velY = 0;
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
