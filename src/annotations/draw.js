/**
 * draw.js — Freehand draw annotation tool
 *
 * Records a path of {x, y, pressure} points in canvas coordinates as the
 * user drags. Points are filtered by a minimum distance threshold to avoid
 * storing thousands of redundant positions during slow movement.
 *
 * Pressure (0.0–1.0) comes from the Pointer Events API for stylus input.
 * For mouse input the browser always reports 0.5, producing a uniform stroke.
 * Pressure is used to vary the stroke width when rendering each segment.
 *
 * Rendering approach:
 *   - Each segment is drawn individually so stroke width can vary per point.
 *   - Segments use round line caps and joins for a smooth, natural feel.
 *   - Live preview draws on the foreground canvas each frame via registerOverlay.
 *
 * Exports: init(), activate(), deactivate(), setColour(), setStrokeWidth()
 */

'use strict';

import { toCanvas, state as viewport }    from '../canvas/viewport.js';
import { registerOverlay, requestRender } from '../canvas/renderer.js';
import { add, getAll }                    from './manager.js';
import { getPages }                       from '../pdf/pdfManager.js';
import { getDragOffset }                  from './select.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum canvas-space distance between consecutive recorded points.
 * Points closer than this are skipped to keep path arrays small.
 */
const MIN_POINT_DISTANCE = 2;

/** Base stroke width in canvas units at pressure 1.0 */
const BASE_STROKE_WIDTH = 2;

/**
 * Pressure exponent — controls how aggressively pressure maps to width.
 * Values below 1.0 make the pen more responsive at low pressure.
 */
const PRESSURE_EXPONENT = 0.7;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let active        = false;
let currentColour = '#f0f0f0';  // Light grey — visible on white PDF pages
let currentWidth  = BASE_STROKE_WIDTH;
let container     = null;

/** Points recorded in the current in-progress stroke */
let livePoints = [];

/** True while a pointer is held down */
let drawing = false;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function init() {
  container = document.getElementById('canvas-container');

  container.addEventListener('pointerdown',   onDown);
  container.addEventListener('pointermove',   onMove);
  container.addEventListener('pointerup',     onUp);
  container.addEventListener('pointercancel', onCancel);

  document.addEventListener('annotations-changed', () => requestRender());

  registerOverlay(drawExisting);
  registerOverlay(drawLivePreview);
}

// ---------------------------------------------------------------------------
// Tool activation
// ---------------------------------------------------------------------------

function activate() {
  active = true;
  container.classList.add('tool-active');
}

function deactivate() {
  active     = false;
  drawing    = false;
  livePoints = [];
  container.classList.remove('tool-active');
  requestRender();
}

/** @param {string} colour — CSS colour string */
function setColour(colour) {
  currentColour = colour;
}

/** @param {number} width — Base stroke width in canvas units */
function setStrokeWidth(width) {
  currentWidth = width;
}

// ---------------------------------------------------------------------------
// Pointer handlers
// ---------------------------------------------------------------------------

function onDown(e) {
  if (!active) return;
  if (e.pointerType === 'touch') return;  // Touch is for panning only
  if (e.button !== 0) return;
  if (e.pointerType === 'mouse' && e.buttons !== 1) return;

  drawing    = true;
  livePoints = [ makePoint(e) ];

  e.stopImmediatePropagation();
  e.preventDefault();
}

function onMove(e) {
  if (!active || !drawing) return;
  if (e.pointerType === 'touch') return;

  const pt   = makePoint(e);
  const last = livePoints[livePoints.length - 1];

  // Only record if the pointer has moved far enough — prevents point bloat
  const dx = pt.x - last.x;
  const dy = pt.y - last.y;
  if (Math.sqrt(dx * dx + dy * dy) >= MIN_POINT_DISTANCE) {
    livePoints.push(pt);
    requestRender();
  }
}

function onUp(e) {
  if (!active || !drawing) return;
  if (e.pointerType === 'touch') return;

  // Push the exact release position so the stroke ends precisely
  livePoints.push(makePoint(e));
  commitStroke();

  drawing    = false;
  livePoints = [];
  requestRender();
}

function onCancel() {
  // Stylus lifted out of range, or touch cancelled — discard the stroke
  drawing    = false;
  livePoints = [];
  requestRender();
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

function commitStroke() {
  if (livePoints.length < 2) return; // Tap with no drag — ignore

  add({
    type:        'draw',
    pageIndex:   resolvePageIndex(livePoints),
    points:      livePoints.slice(),
    strokeWidth: currentWidth,
    colour:      currentColour,
  });
}

// ---------------------------------------------------------------------------
// Draw callbacks (called every frame by renderer, already in canvas space)
// ---------------------------------------------------------------------------

/** Draws all committed draw annotations. */
function drawExisting(ctx) {
  for (const anno of getAll()) {
    if (anno.type !== 'draw') continue;
    const offset = getDragOffset(anno.id);
    if (offset) {
      ctx.save();
      ctx.translate(offset.dx, offset.dy);
      drawPath(ctx, anno.points, anno.strokeWidth, anno.colour);
      ctx.restore();
    } else {
      drawPath(ctx, anno.points, anno.strokeWidth, anno.colour);
    }
  }
}

/** Draws the stroke in progress while the pointer is still held. */
function drawLivePreview(ctx) {
  if (!drawing || livePoints.length < 2) return;
  drawPath(ctx, livePoints, currentWidth, currentColour);
}

// ---------------------------------------------------------------------------
// Path rendering
// ---------------------------------------------------------------------------

/**
 * Renders a stroke as a single smooth quadratic bezier curve.
 *
 * Drawing each segment separately with round caps caused visible dots at
 * every joint: overlapping round caps with slightly varying alpha produced
 * darker circles at each junction. Fix: one continuous bezier path per
 * stroke, eliminating all joints. Width is derived from average pressure.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number, y:number, pressure:number}>} points
 * @param {number} baseWidth — Canvas-unit stroke width at full pressure
 * @param {string} colour    — CSS colour string
 */
function drawPath(ctx, points, baseWidth, colour) {
  if (points.length < 2) return;

  // Average pressure across all points → single stroke width per stroke.
  // Varying width segment-by-segment with round caps creates joint artifacts;
  // a single width per stroke is a good trade-off for natural-looking lines.
  const avgPressure = points.reduce((s, p) => s + p.pressure, 0) / points.length;
  const pressureWidth = baseWidth * Math.pow(Math.min(avgPressure * 2, 1), PRESSURE_EXPONENT);

  // Enforce a minimum of 1.5 physical pixels regardless of zoom level.
  // Without this, zooming out makes strokes sub-pixel and blurry/invisible.
  const dpr = window.devicePixelRatio || 1;
  const minWidth = 1.5 / (viewport.scale * dpr);
  const width = Math.max(pressureWidth, minWidth);

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  // Smooth through midpoints using quadratic bezier curves.
  // Each control point is the recorded point; the anchor is the midpoint
  // between consecutive points. This produces a smooth, natural-feeling curve.
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
  }

  // End exactly at the last point
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);

  ctx.strokeStyle = colour;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a canvas-space point from a pointer event.
 *
 * @param {PointerEvent} e
 * @returns {{ x: number, y: number, pressure: number }}
 */
function makePoint(e) {
  const rect     = container.getBoundingClientRect();
  const { x, y } = toCanvas(e.clientX - rect.left, e.clientY - rect.top);
  // Clamp to [0.1, 1.0] — some devices report 0 before pen touches surface
  const pressure = Math.max(0.1, Math.min(1.0, e.pressure || 0.5));
  return { x, y, pressure };
}

/**
 * Resolves the page index for a stroke using the centroid of its points.
 *
 * @param {Array<{x:number, y:number}>} points
 * @returns {number} pageIndex
 */
function resolvePageIndex(points) {
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  cx /= points.length;
  cy /= points.length;

  for (const page of getPages()) {
    if (
      cx >= page.canvasX && cx <= page.canvasX + page.width &&
      cy >= page.canvasY && cy <= page.canvasY + page.height
    ) return page.pageIndex;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initDraw, activate, deactivate, setColour, setStrokeWidth };
