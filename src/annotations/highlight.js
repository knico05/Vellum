/**
 * highlight.js — Pen-like highlighter annotation tool
 *
 * Draws a freehand semi-transparent stroke that follows the pointer path,
 * like a felt-tip highlighter pen. The stroke is uniformly thick with no
 * pressure variation — real highlighters don't taper.
 *
 * Annotation schema:
 *   { type:'highlight', pageIndex, colour, strokeWidth, points:[{x,y}] }
 *
 * Note: the old rect-based schema used {canvasX, canvasY, width, height}.
 * Both are handled in drawExisting for backward compatibility with saved files.
 *
 * Exports: initHighlight(), activate(), deactivate(), setColour(), setStrokeWidth()
 */

'use strict';

import { toCanvas }                        from '../canvas/viewport.js';
import { registerOverlay, requestRender }  from '../canvas/renderer.js';
import { add, getAll }                     from './manager.js';
import { resolvePageId }                   from '../pages/pageManager.js';
import { getDragOffset }                   from './select.js';
import { detectShape, axisSnapEndpoint }   from './shape.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Semi-transparent colours for each logical colour name.
 * Higher alpha than draw strokes so text underneath stays readable.
 */
const COLOURS = {
  blue:   'rgba(91,  138, 245, 0.45)',
  black:  'rgba(10,  10,  10,  0.55)',
  yellow: 'rgba(255, 213, 79,  0.45)',
  red:    'rgba(229, 62,  62,  0.45)',
  green:  'rgba(72,  199, 116, 0.45)',
};

/** Default stroke width in canvas units — thick like a real marker */
const DEFAULT_STROKE_WIDTH = 16;

/** Minimum canvas-space distance between consecutive recorded points */
const MIN_POINT_DISTANCE = 2;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let active           = false;
let currentColourCss = COLOURS.blue;  // Resolved CSS rgba string
let currentWidth     = DEFAULT_STROKE_WIDTH;
let container        = null;

/** Points recorded in the current in-progress stroke */
let livePoints = [];

/** True while a pointer is held down */
let drawing = false;

/** Whether hold-to-snap shape recognition is enabled */
let shapeSnapOn = true;

/** setTimeout handle for the hold timer (500 ms stillness → snap attempt) */
let holdTimer = null;

/**
 * Shape snap result from detectShape(), or null.
 * Set by the hold timer; used by drawLivePreview and commitStroke.
 */
let snappedData = null;

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
  clearTimeout(holdTimer);
  holdTimer   = null;
  active      = false;
  drawing     = false;
  livePoints  = [];
  snappedData = null;
  container.classList.remove('tool-active');
  requestRender();
}

/** @param {boolean} enabled */
function setShapeSnap(enabled) {
  shapeSnapOn = enabled;
}

/**
 * Sets the colour for new highlights.
 * Accepts either a preset name ('yellow') or a raw hex string ('#ff5733').
 * Hex colours are converted to semi-transparent rgba so they behave like
 * a real highlighter over text.
 *
 * @param {string} colour — Preset name or CSS hex string
 */
function setColour(colour) {
  if (colour in COLOURS) {
    currentColourCss = COLOURS[colour];
  } else if (colour.startsWith('#')) {
    currentColourCss = hexToRgba(colour, 0.45);
  } else {
    currentColourCss = colour; // Already a full CSS colour string
  }
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
  if (e.pointerType === 'touch') return;
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

  // Snap-adjust mode: after hold-to-snap fires, pen movement repositions the shape
  // instead of recording more points. Mirrors draw.js behaviour.
  if (snappedData) {
    const pt = makePoint(e);
    if (snappedData.shapeType === 'line') {
      const snapped = axisSnapEndpoint(snappedData.idealPoints[0], pt);
      snappedData.idealPoints[1] = { x: snapped.x, y: snapped.y };
    } else if (snappedData.shapeType === 'rect') {
      const p0   = livePoints[0];
      const minX = Math.min(p0.x, pt.x), maxX = Math.max(p0.x, pt.x);
      const minY = Math.min(p0.y, pt.y), maxY = Math.max(p0.y, pt.y);
      snappedData.idealPoints = [
        { x: minX, y: minY }, { x: maxX, y: minY },
        { x: maxX, y: maxY }, { x: minX, y: maxY },
      ];
    } else if (snappedData.shapeType === 'circle') {
      const dx = pt.x - snappedData.cx, dy = pt.y - snappedData.cy;
      snappedData.r = Math.sqrt(dx * dx + dy * dy);
    } else if (snappedData.shapeType === 'ellipse') {
      snappedData.rx = Math.abs(pt.x - snappedData.cx);
      snappedData.ry = Math.abs(pt.y - snappedData.cy);
    } else if (snappedData.shapeType === 'corner') {
      snappedData.idealPoints[snappedData.idealPoints.length - 1] = { x: pt.x, y: pt.y };
    }
    requestRender();
    return;
  }

  const pt   = makePoint(e);
  const last = livePoints[livePoints.length - 1];
  const dx   = pt.x - last.x;
  const dy   = pt.y - last.y;

  if (Math.sqrt(dx * dx + dy * dy) >= MIN_POINT_DISTANCE) {
    livePoints.push(pt);

    // Movement: cancel any pending snap and restart the hold timer
    clearTimeout(holdTimer);
    snappedData = null;
    if (shapeSnapOn) {
      holdTimer = setTimeout(_trySnapHold, 500);
    }

    requestRender();
  }
}

function onUp(e) {
  if (!active || !drawing) return;
  if (e.pointerType === 'touch') return;

  clearTimeout(holdTimer);
  holdTimer = null;

  livePoints.push(makePoint(e));
  commitStroke();

  drawing     = false;
  livePoints  = [];
  snappedData = null;
  requestRender();
}

function onCancel() {
  clearTimeout(holdTimer);
  holdTimer   = null;
  drawing     = false;
  livePoints  = [];
  snappedData = null;
  requestRender();
}

/**
 * Called after 500 ms of pointer stillness — attempts to snap the current
 * path to a recognised geometric shape (line, rect, or circle).
 */
function _trySnapHold() {
  holdTimer = null;
  if (!drawing || livePoints.length < 5) return;
  const snap = detectShape(livePoints);
  if (snap) {
    snappedData = snap;
    requestRender(); // immediately show snapped shape in live preview
  }
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

function commitStroke() {
  if (livePoints.length < 2) return;

  const base = { type: 'highlight', strokeWidth: currentWidth, colour: currentColourCss };

  if (snappedData?.shapeType === 'circle') {
    // Circle snap — store geometry directly (no points array)
    add({
      ...base,
      pageId:    resolvePageId(snappedData.cx, snappedData.cy),
      points:    [],
      shapeType: 'circle',
      cx:        snappedData.cx,
      cy:        snappedData.cy,
      r:         snappedData.r,
    });
    return;
  }

  const pts = snappedData?.idealPoints ?? livePoints;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length;
  cy /= pts.length;

  add({
    ...base,
    pageId:    resolvePageId(cx, cy),
    points:    pts.slice(),
    shapeType: snappedData?.shapeType ?? null,
  });
}

// ---------------------------------------------------------------------------
// Draw callbacks (called every frame by renderer, already in canvas space)
// ---------------------------------------------------------------------------

/**
 * Draws all committed highlight annotations.
 * Handles both the new path-based schema and the old rect-based schema.
 */
function drawExisting(ctx) {
  for (const anno of getAll()) {
    if (anno.type !== 'highlight') continue;

    // COLOURS[anno.colour] handles old named presets ('yellow' etc.)
    // anno.colour fallback handles new CSS strings stored directly
    const colour = COLOURS[anno.colour] ?? anno.colour ?? COLOURS.yellow;
    const offset = getDragOffset(anno.id);
    const width  = anno.strokeWidth ?? DEFAULT_STROKE_WIDTH;

    if (anno.shapeType === 'circle') {
      // Circle snap — stored as cx/cy/r
      const cx = anno.cx + (offset ? offset.dx : 0);
      const cy = anno.cy + (offset ? offset.dy : 0);
      drawHighlightCircle(ctx, cx, cy, anno.r, width, colour);
    } else if (anno.points) {
      // Path-based (freehand, line, or rect)
      if (offset) {
        ctx.save();
        ctx.translate(offset.dx, offset.dy);
        _drawHighlightAnno(ctx, anno, colour, width);
        ctx.restore();
      } else {
        _drawHighlightAnno(ctx, anno, colour, width);
      }
    } else {
      // Legacy rect-based highlight — draw as filled rect
      const x = anno.canvasX + (offset ? offset.dx : 0);
      const y = anno.canvasY + (offset ? offset.dy : 0);
      ctx.fillStyle = colour;
      ctx.fillRect(x, y, anno.width, anno.height);
    }
  }
}

/** Dispatches to the right path renderer based on shapeType. */
function _drawHighlightAnno(ctx, anno, colour, width) {
  if (anno.shapeType === 'rect') {
    drawHighlightShapePath(ctx, anno.points, true,  width, colour);
  } else if (anno.shapeType === 'line') {
    drawHighlightShapePath(ctx, anno.points, false, width, colour);
  } else {
    drawHighlightPath(ctx, anno.points, width, colour);
  }
}

/** Draws the stroke in progress while the pointer is still held. */
function drawLivePreview(ctx) {
  if (!drawing || livePoints.length < 2) return;

  if (snappedData?.shapeType === 'circle') {
    drawHighlightCircle(ctx, snappedData.cx, snappedData.cy, snappedData.r,
                        currentWidth, currentColourCss);
  } else if (snappedData?.shapeType === 'rect' && snappedData.idealPoints) {
    drawHighlightShapePath(ctx, snappedData.idealPoints, true, currentWidth, currentColourCss);
  } else if (snappedData?.idealPoints) {
    drawHighlightShapePath(ctx, snappedData.idealPoints, false, currentWidth, currentColourCss);
  } else {
    drawHighlightPath(ctx, livePoints, currentWidth, currentColourCss);
  }
}

// ---------------------------------------------------------------------------
// Path rendering
// ---------------------------------------------------------------------------

/**
 * Renders a circle highlight using ctx.arc().
 * Matches how draw.js renders snapped circles.
 */
function drawHighlightCircle(ctx, cx, cy, r, width, colour) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.strokeStyle = colour;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';
  ctx.stroke();
}

/**
 * Renders a snapped line or rect highlight using straight line segments.
 * Rects use miter joins for sharp corners; lines use round caps.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number, y:number}>} points
 * @param {boolean} close — true for rect (joins last point to first)
 * @param {number}  width
 * @param {string}  colour
 */
function drawHighlightShapePath(ctx, points, close, width, colour) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  if (close) ctx.closePath();
  ctx.strokeStyle = colour;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'square';
  ctx.lineJoin    = 'miter';
  ctx.stroke();
}

/**
 * Renders a highlighter stroke as a smooth quadratic bezier path.
 *
 * Key differences from draw.js:
 *   - Uniform width (no pressure variation) — real markers don't taper
 *   - Semi-transparent colour passed in as an rgba string
 *   - Square lineCap for a flat marker-tip feel at stroke ends
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number, y:number}>} points
 * @param {number} width   — Canvas-unit stroke width
 * @param {string} colour  — CSS rgba string
 */
function drawHighlightPath(ctx, points, width, colour) {
  if (points.length < 2) return;

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
  }

  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);

  ctx.strokeStyle = colour;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'square';
  ctx.lineJoin    = 'round';
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a CSS hex colour (#rrggbb) to an rgba string with the given alpha.
 * Used so custom colours get the same semi-transparent look as preset highlights.
 *
 * @param {string} hex   — e.g. '#ff5733'
 * @param {number} alpha — 0.0–1.0
 * @returns {string}     — e.g. 'rgba(255, 87, 51, 0.45)'
 */
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function makePoint(e) {
  const rect     = container.getBoundingClientRect();
  const { x, y } = toCanvas(e.clientX - rect.left, e.clientY - rect.top);
  return { x, y };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initHighlight, activate, deactivate, setColour, setStrokeWidth, setShapeSnap };
