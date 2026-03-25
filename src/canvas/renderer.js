/**
 * renderer.js — Draws everything onto the infinite canvas each frame
 *
 * Owns a <canvas> element that fills #canvas-container. Uses a
 * requestAnimationFrame loop with a dirty flag — only redraws when state
 * has changed, preventing wasted CPU on idle frames.
 *
 * Draw order each frame:
 *   1. Clear
 *   2. Apply viewport transform (pan + scale via ctx.setTransform)
 *   3. Draw dot-grid background
 *   4. Call all registered draw functions in registration order
 *
 * Other modules call register(fn) to add themselves to the draw list, and
 * requestRender() to flag that a redraw is needed.
 *
 * Exports: init(), requestRender(), register()
 */

'use strict';

import { state as viewport, toCanvas } from './viewport.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Spacing between grid dots in canvas units */
const GRID_SIZE = 24;

/** Radius of each grid dot in screen pixels (stays constant regardless of zoom) */
const DOT_RADIUS = 1;

/**
 * Don't draw the dot grid when zoomed so far out that dots would be
 * closer than this many screen pixels — it would look like a solid fill.
 */
const MIN_DOT_SPACING_PX = 4;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The <canvas> element we own */
let canvas = null;

/** 2D rendering context for the canvas */
let ctx = null;

/** True when something has changed and a redraw is needed */
let dirty = true;

/** Functions registered by other modules to draw their content each frame */
const drawCallbacks = [];

/** Cached dot colour — read once from CSS, avoids getComputedStyle every frame */
let dotColour = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Creates the <canvas> element, inserts it into #canvas-container, starts
 * the animation loop, and sets up resize handling.
 *
 * Must be called once after the DOM is ready.
 */
function init() {
  const container = document.getElementById('canvas-container');

  canvas = document.createElement('canvas');
  canvas.id = 'main-canvas';
  canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
  container.appendChild(canvas);

  // Read the dot colour from the CSS variable once
  dotColour = getComputedStyle(document.documentElement)
    .getPropertyValue('--border-subtle')
    .trim() || '#2a2a2a';

  // Match canvas size to container, re-match on resize
  resizeToContainer();
  const resizeObserver = new ResizeObserver(() => {
    resizeToContainer();
    requestRender();
  });
  resizeObserver.observe(container);

  // Start the loop
  requestAnimationFrame(loop);
}

/**
 * Sizes the canvas to exactly fill its container.
 * Must be called whenever the container resizes; drawing to a mis-sized
 * canvas produces blurry or clipped output.
 */
function resizeToContainer() {
  const container = document.getElementById('canvas-container');
  const { width, height } = container.getBoundingClientRect();
  canvas.width  = Math.floor(width);
  canvas.height = Math.floor(height);
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------

/**
 * The animation loop. Runs every frame (~60/120fps depending on monitor).
 * Only redraws when dirty === true, then clears the flag.
 *
 * Never call this directly — it's self-scheduling via requestAnimationFrame.
 */
function loop() {
  if (dirty) {
    render();
    dirty = false;
  }
  requestAnimationFrame(loop);
}

/**
 * Flags that a redraw is needed on the next frame.
 * Call this whenever viewport state or drawn content changes.
 */
function requestRender() {
  dirty = true;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Performs one full redraw:
 *   1. Clears the canvas
 *   2. Applies the viewport transform
 *   3. Draws the dot grid
 *   4. Calls all registered draw functions
 */
function render() {
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;

  // 1. Clear
  ctx.clearRect(0, 0, W, H);

  // 2. Apply viewport transform
  //    ctx.setTransform(scaleX, skewY, skewX, scaleY, translateX, translateY)
  //    This maps canvas-space coordinates to screen pixels automatically,
  //    so everything drawn after this is in canvas space.
  ctx.setTransform(viewport.scale, 0, 0, viewport.scale, viewport.panX, viewport.panY);

  // 3. Draw dot grid
  drawGrid(W, H);

  // 4. Call registered draw functions (PDF pages, annotations, etc.)
  for (const fn of drawCallbacks) {
    ctx.save();
    fn(ctx, viewport);
    ctx.restore();
  }

  // Reset transform for any subsequent screen-space drawing
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * Draws the infinite dot grid.
 *
 * The grid is drawn in canvas space (after the viewport transform is applied).
 * We compute which grid cells are visible on screen, then draw only those —
 * never iterating over the full infinite plane.
 *
 * At very low zoom levels the dots would overlap; we skip the grid below a
 * minimum screen-space dot spacing to keep it readable.
 *
 * @param {number} screenW — Canvas element width in pixels
 * @param {number} screenH — Canvas element height in pixels
 */
function drawGrid(screenW, screenH) {
  // Skip grid if zoomed so far out that dots would merge
  const dotSpacingPx = GRID_SIZE * viewport.scale;
  if (dotSpacingPx < MIN_DOT_SPACING_PX) return;

  // Find the canvas-space bounds of what's currently visible on screen
  const topLeft     = toCanvas(0,       0);
  const bottomRight = toCanvas(screenW, screenH);

  // Snap to nearest grid line
  const startX = Math.floor(topLeft.x     / GRID_SIZE) * GRID_SIZE;
  const startY = Math.floor(topLeft.y     / GRID_SIZE) * GRID_SIZE;
  const endX   = Math.ceil(bottomRight.x  / GRID_SIZE) * GRID_SIZE;
  const endY   = Math.ceil(bottomRight.y  / GRID_SIZE) * GRID_SIZE;

  // Dot radius in canvas units: we want DOT_RADIUS screen pixels regardless
  // of zoom, so divide by scale.
  const dotR = DOT_RADIUS / viewport.scale;

  ctx.fillStyle = dotColour;
  ctx.beginPath();

  for (let x = startX; x <= endX; x += GRID_SIZE) {
    for (let y = startY; y <= endY; y += GRID_SIZE) {
      ctx.moveTo(x + dotR, y);
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
    }
  }

  ctx.fill();
}

// ---------------------------------------------------------------------------
// Draw callback registry
// ---------------------------------------------------------------------------

/**
 * Registers a function to be called every frame during rendering.
 * The function receives (ctx, viewportState) and should draw in canvas space.
 * ctx.save() / ctx.restore() are called around each registered function.
 *
 * @param {function(CanvasRenderingContext2D, object): void} fn
 */
function register(fn) {
  drawCallbacks.push(fn);
}

// Expose the canvas element for input.js to attach events to
function getCanvas() {
  return canvas;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init, requestRender, register, getCanvas };
