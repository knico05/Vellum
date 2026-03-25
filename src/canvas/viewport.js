/**
 * viewport.js — Pan, zoom, and coordinate transform logic
 *
 * The infinite canvas has two coordinate spaces:
 *
 *   Canvas space  — The abstract world where objects live. PDF pages,
 *                   annotations, and sticky notes are all positioned in
 *                   canvas coordinates. These are what we store on disk.
 *
 *   Screen space  — Pixel coordinates on the user's monitor. What gets
 *                   drawn. Changes every time the user pans or zooms.
 *
 * The viewport transform converts between them:
 *
 *   screenX = canvasX * scale + panX
 *   screenY = canvasY * scale + panY
 *
 *   canvasX = (screenX - panX) / scale
 *   canvasY = (screenY - panY) / scale
 *
 * toScreen() and toCanvas() are the only correct way to do these conversions.
 * Never calculate coordinate transforms inline elsewhere in the codebase.
 *
 * Exports: state, toScreen(), toCanvas(), applyZoom(), applyPan(), reset()
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SCALE = 0.05;  // 5% — far out
const MAX_SCALE = 8.0;   // 800% — very close
const ZOOM_FACTOR = 0.001; // Multiplier applied to scroll wheel delta

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The single mutable viewport state object.
 * All other modules read this; only this module writes it.
 *
 * panX, panY: translation in screen pixels (how far we've dragged)
 * scale:      zoom level (1.0 = 100%)
 */
const state = {
  panX: 0,
  panY: 0,
  scale: 1.0,
};

// ---------------------------------------------------------------------------
// Core transform functions
// ---------------------------------------------------------------------------

/**
 * Converts a point in canvas space to screen space.
 * Use this when you know where something is on the canvas and need to know
 * where to draw it on screen.
 *
 * @param {number} canvasX
 * @param {number} canvasY
 * @returns {{ x: number, y: number }} Position in screen pixels
 */
function toScreen(canvasX, canvasY) {
  return {
    x: canvasX * state.scale + state.panX,
    y: canvasY * state.scale + state.panY,
  };
}

/**
 * Converts a point in screen space to canvas space.
 * Use this for hit testing: when the user clicks at screen position (sx, sy),
 * call toCanvas(sx, sy) to get the canvas coordinate they clicked on.
 *
 * @param {number} screenX
 * @param {number} screenY
 * @returns {{ x: number, y: number }} Position in canvas coordinates
 */
function toCanvas(screenX, screenY) {
  return {
    x: (screenX - state.panX) / state.scale,
    y: (screenY - state.panY) / state.scale,
  };
}

// ---------------------------------------------------------------------------
// Viewport manipulation
// ---------------------------------------------------------------------------

/**
 * Zooms the viewport toward a point in screen space.
 *
 * The key requirement: the canvas point currently under (originX, originY)
 * must remain under (originX, originY) after the zoom. If the cursor is over
 * a particular word, that word must stay under the cursor after zoom.
 *
 * Derivation:
 *   Let (cx, cy) be the canvas point under the cursor before zoom:
 *     cx = (originX - panX) / scale
 *   After zoom to newScale, we want originX = cx * newScale + newPanX:
 *     newPanX = originX - cx * newScale
 *            = originX - ((originX - panX) / scale) * newScale
 *
 * @param {number} delta   — Positive = zoom in, negative = zoom out
 * @param {number} originX — Screen X to zoom toward (typically mouse X)
 * @param {number} originY — Screen Y to zoom toward (typically mouse Y)
 */
function applyZoom(delta, originX, originY) {
  const newScale = Math.max(
    MIN_SCALE,
    Math.min(MAX_SCALE, state.scale * (1 + delta))
  );

  if (newScale === state.scale) return; // Already at limit

  // Canvas point currently under the cursor
  const canvasX = (originX - state.panX) / state.scale;
  const canvasY = (originY - state.panY) / state.scale;

  // After scale change, adjust pan so the same canvas point stays under cursor
  state.panX = originX - canvasX * newScale;
  state.panY = originY - canvasY * newScale;
  state.scale = newScale;
}

/**
 * Pans the viewport by a delta in screen pixels.
 *
 * @param {number} dx — Pixels to move horizontally (positive = right)
 * @param {number} dy — Pixels to move vertically (positive = down)
 */
function applyPan(dx, dy) {
  state.panX += dx;
  state.panY += dy;
}

/**
 * Resets the viewport to 100% zoom centered on the origin (0, 0).
 * Called when opening a new PDF before repositioning to the first page.
 */
function reset() {
  state.panX  = 0;
  state.panY  = 0;
  state.scale = 1.0;
}

/**
 * Centres the viewport on a rectangle in canvas space.
 * Used after loading a PDF to bring page 1 into view.
 *
 * @param {number} canvasX      — Left edge of the rectangle
 * @param {number} canvasY      — Top edge of the rectangle
 * @param {number} canvasWidth  — Width of the rectangle
 * @param {number} canvasHeight — Height of the rectangle
 * @param {number} screenWidth  — Available screen width
 * @param {number} screenHeight — Available screen height
 * @param {number} [padding=48] — Pixels of padding around the content
 */
function centreOn(canvasX, canvasY, canvasWidth, canvasHeight, screenWidth, screenHeight, padding = 48) {
  const scaleX = (screenWidth  - padding * 2) / canvasWidth;
  const scaleY = (screenHeight - padding * 2) / canvasHeight;
  state.scale = Math.min(scaleX, scaleY, 1.0); // Don't zoom in past 100%

  // Centre the rectangle on screen
  state.panX = screenWidth  / 2 - (canvasX + canvasWidth  / 2) * state.scale;
  state.panY = screenHeight / 2 - (canvasY + canvasHeight / 2) * state.scale;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { state, toScreen, toCanvas, applyZoom, applyPan, reset, centreOn, MIN_SCALE, MAX_SCALE, ZOOM_FACTOR };
