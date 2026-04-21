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
 * Exports: init(), activate(), deactivate(), setColour(), setStrokeWidth(), setPressureSensitive(), setShapeSnap()
 */

'use strict';

import { toCanvas, state as viewport }    from '../canvas/viewport.js';
import { registerOverlay, requestRender, exitDeferredMode } from '../canvas/renderer.js';
import { add, getAll }                    from './manager.js';
import { resolvePageId }                  from '../pages/pageManager.js';
import { getDragOffset }                  from './select.js';
import { detectShape, axisSnapEndpoint }  from './shape.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Returns the minimum canvas-space distance between consecutive recorded points.
 * Scales with stroke width: thinner strokes need more points for smooth curves.
 * A fine pen (width 1) uses 0.5; a brush (width 8) uses 2.
 *
 * @param {number} strokeWidth
 * @returns {number}
 */
function minPointDistance(strokeWidth) {
  return Math.max(0.5, strokeWidth * 0.5);
}

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

// ---------------------------------------------------------------------------
// Committed-stroke cache (oversized)
//
// Re-drawing every bezier curve on every frame is O(strokes × points) and
// tanks frame rate when there are many annotations. We pre-render all strokes
// into an OffscreenCanvas and blit it each frame instead (one drawImage call).
//
// The cache is built LARGER than the viewport — one full viewport of buffer on
// each side (3× total). Panning within that buffer only shifts the blit offset;
// no rebuild is needed. This eliminates blank-area artifacts while keeping
// full redraws fast across typical pan distances.
//
// Invalidated when: strokes added/removed, scale changes, pan exceeds buffer.
// ---------------------------------------------------------------------------

/** How much extra space to add around the viewport on each side (fraction). */
const CACHE_BUFFER = 1.0; // 1.0 = one full viewport of padding on each side

/** The oversized OffscreenCanvas, or null when stale. */
let _strokeCache = null;

/** Viewport state and buffer offsets at cache build time. */
let _cacheVpScale = null;
let _cacheVpPanX  = null;
let _cacheVpPanY  = null;
let _cacheBufX    = 0;   // physical-pixel buffer on left/right
let _cacheBufY    = 0;   // physical-pixel buffer on top/bottom

function _invalidateCache() { _strokeCache = null; }

function _isCacheValid(W, H) {
  if (!_strokeCache || _cacheVpScale !== viewport.scale) return false;
  const dpr  = window.devicePixelRatio || 1;
  const panDx = (viewport.panX - _cacheVpPanX) * dpr;
  const panDy = (viewport.panY - _cacheVpPanY) * dpr;
  // Valid while pan delta stays within the pre-rendered buffer
  return Math.abs(panDx) <= _cacheBufX && Math.abs(panDy) <= _cacheBufY;
}

function _buildCache(W, H, dpr) {
  const bufX = Math.round(W * CACHE_BUFFER);
  const bufY = Math.round(H * CACHE_BUFFER);
  const BW   = W + 2 * bufX;
  const BH   = H + 2 * bufY;

  // Reuse the existing buffer when possible — avoids a costly GPU reallocation
  if (!_strokeCache || _strokeCache.width !== BW || _strokeCache.height !== BH) {
    _strokeCache = new OffscreenCanvas(BW, BH);
  }
  const cacheCtx = _strokeCache.getContext('2d');
  cacheCtx.clearRect(0, 0, BW, BH);

  // The current viewport is centred inside the oversized buffer.
  // bufX / bufY shift the viewport origin so strokes in both directions are covered.
  cacheCtx.setTransform(
    viewport.scale * dpr, 0,
    0, viewport.scale * dpr,
    viewport.panX * dpr + bufX,
    viewport.panY * dpr + bufY,
  );
  for (const anno of getAll()) {
    if (anno.type !== 'draw') continue;
    cacheCtx.save();
    _renderAnnotation(cacheCtx, anno);
    cacheCtx.restore();
  }

  _cacheVpScale = viewport.scale;
  _cacheVpPanX  = viewport.panX;
  _cacheVpPanY  = viewport.panY;
  _cacheBufX    = bufX;
  _cacheBufY    = bufY;
}

/** True while a pointer is held down */
let drawing = false;

/** Whether stroke width varies with stylus pressure (default on) */
let pressureSensitive = true;

/** Whether hold-to-snap shape recognition is enabled */
let shapeSnapOn = true;

/** setTimeout handle for the 1-second hold timer */
let holdTimer = null;

/**
 * Shape snap result from detectShape(), set by the hold timer.
 * Structure: { shapeType, idealPoints? } for line/rect, or { shapeType, cx, cy, r } for circle.
 * When set, the live preview and commit use this instead of livePoints.
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

  document.addEventListener('annotations-changed', () => { exitDeferredMode(); _invalidateCache(); requestRender(); });

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

/** @param {string} colour — CSS colour string */
function setColour(colour) {
  currentColour = colour;
}

/** @param {number} width — Base stroke width in canvas units */
function setStrokeWidth(width) {
  currentWidth = width;
}

/** @param {boolean} enabled — Whether stylus pressure affects stroke width */
function setPressureSensitive(enabled) {
  pressureSensitive = enabled;
}

/** @param {boolean} enabled — Whether hold-to-snap shape recognition is active */
function setShapeSnap(enabled) {
  shapeSnapOn = enabled;
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

  // Once a shape has snapped, enter snap-adjust mode: the user can still move
  // the pen to reposition the shape's endpoint/corner/radius before lifting.
  // This lets them fine-tune alignment without un-snapping.
  if (snappedData) {
    const pt = makePoint(e);
    if (snappedData.shapeType === 'line') {
      // Move the endpoint (index 1) toward the pen, snapping to H/V when close.
      // axisSnapEndpoint makes the line "stick" at 0°/90° so the user sees a
      // brief visual pause as feedback that the line is perfectly aligned.
      const snapped = axisSnapEndpoint(snappedData.idealPoints[0], pt);
      snappedData.idealPoints[1] = { x: snapped.x, y: snapped.y, pressure: 0.5 };
    } else if (snappedData.shapeType === 'rect') {
      // On first move after snap, find the corner of the snapped rect that is
      // farthest from the pen — that corner stays fixed while the opposite one
      // (nearest to the pen) follows the drag.
      if (!snappedData._anchorPt) {
        let farthestDist = -1;
        let farthestCorner = snappedData.idealPoints[0];
        for (const corner of snappedData.idealPoints) {
          const d = (corner.x - pt.x) ** 2 + (corner.y - pt.y) ** 2;
          if (d > farthestDist) { farthestDist = d; farthestCorner = corner; }
        }
        snappedData._anchorPt = { x: farthestCorner.x, y: farthestCorner.y };
      }
      const anchor = snappedData._anchorPt;
      const minX = Math.min(anchor.x, pt.x);
      const maxX = Math.max(anchor.x, pt.x);
      const minY = Math.min(anchor.y, pt.y);
      const maxY = Math.max(anchor.y, pt.y);
      snappedData.idealPoints = [
        { x: minX, y: minY, pressure: 0.5 }, // TL
        { x: maxX, y: minY, pressure: 0.5 }, // TR
        { x: maxX, y: maxY, pressure: 0.5 }, // BR
        { x: minX, y: maxY, pressure: 0.5 }, // BL
      ];
    } else if (snappedData.shapeType === 'circle') {
      // Adjust radius: distance from the snapped centre to the current pen position
      const dx = pt.x - snappedData.cx;
      const dy = pt.y - snappedData.cy;
      snappedData.r = Math.sqrt(dx * dx + dy * dy);
    } else if (snappedData.shapeType === 'ellipse') {
      // Adjust semi-axes: delta from the snapped centre to the pen position
      snappedData.rx = Math.abs(pt.x - snappedData.cx);
      snappedData.ry = Math.abs(pt.y - snappedData.cy);
    }
    requestRender();
    return;
  }

  const pt   = makePoint(e);
  const last = livePoints[livePoints.length - 1];

  // Only record if the pointer has moved far enough — prevents point bloat.
  // Threshold scales with stroke width so thin pens record more points.
  const dx = pt.x - last.x;
  const dy = pt.y - last.y;
  if (Math.sqrt(dx * dx + dy * dy) >= minPointDistance(currentWidth)) {
    livePoints.push(pt);

    // Movement detected: cancel any pending snap and restart the hold timer
    clearTimeout(holdTimer);
    if (shapeSnapOn) {
      holdTimer = setTimeout(_trySnapHold, 500);
    }

    requestRender();
  }
}

function onUp(e) {
  if (!active || !drawing) return;
  if (e.pointerType === 'touch') return;

  // Cancel hold timer — commit happens now regardless
  clearTimeout(holdTimer);
  holdTimer = null;

  // Push the exact release position so the stroke ends precisely
  livePoints.push(makePoint(e));
  commitStroke();

  drawing     = false;
  livePoints  = [];
  snappedData = null;
  requestRender();
}

function onCancel() {
  // Stylus lifted out of range, or touch cancelled — discard the stroke
  clearTimeout(holdTimer);
  holdTimer   = null;
  drawing     = false;
  livePoints  = [];
  snappedData = null;
  requestRender();
}

// ---------------------------------------------------------------------------
// Shape snap (hold-to-snap)
// ---------------------------------------------------------------------------

/**
 * Fired by the hold timer after 1 second of no pen movement.
 * Runs shape detection on the current livePoints and stores the idealised
 * replacement data in snappedData. The live preview immediately shows
 * the snapped shape while the pen is still held down.
 */
function _trySnapHold() {
  holdTimer = null;
  if (!drawing || livePoints.length < 5) return;
  const snap = detectShape(livePoints);
  if (snap) {
    snappedData = snap; // { shapeType, idealPoints? } or { shapeType, cx, cy, r }
    requestRender();    // immediately show snapped shape in live preview
  }
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

function commitStroke() {
  if (livePoints.length < 2) return; // Tap with no drag — ignore

  if (snappedData) {
    // Commit the recognised shape with its geometry stored explicitly
    const base = {
      type:        'draw',
      shapeType:   snappedData.shapeType,
      strokeWidth: currentWidth,
      colour:      currentColour,
    };

    if (snappedData.shapeType === 'circle') {
      add({ ...base, pageId: resolvePageId(snappedData.cx, snappedData.cy),
                     cx: snappedData.cx, cy: snappedData.cy, r: snappedData.r,
                     points: [] });
    } else if (snappedData.shapeType === 'ellipse') {
      add({ ...base, pageId: resolvePageId(snappedData.cx, snappedData.cy),
                     cx: snappedData.cx, cy: snappedData.cy,
                     rx: snappedData.rx, ry: snappedData.ry,
                     points: [] });
    } else {
      // line or rect — use idealPoints
      const pts = snappedData.idealPoints;
      let pcx = 0, pcy = 0;
      for (const p of pts) { pcx += p.x; pcy += p.y; }
      add({ ...base, pageId: resolvePageId(pcx / pts.length, pcy / pts.length),
                     points: pts.slice() });
    }
    return;
  }

  // Normal freehand stroke
  let cx = 0, cy = 0;
  for (const p of livePoints) { cx += p.x; cy += p.y; }
  cx /= livePoints.length;
  cy /= livePoints.length;

  add({
    type:        'draw',
    pageId:      resolvePageId(cx, cy),
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
  const hasDragged = getAll().some(a => a.type === 'draw' && getDragOffset(a.id));

  if (hasDragged) {
    // During a drag fall back to per-stroke redraw so the offset applies correctly
    for (const anno of getAll()) {
      if (anno.type !== 'draw') continue;
      const offset = getDragOffset(anno.id);
      if (offset) {
        ctx.save();
        ctx.translate(offset.dx, offset.dy);
        _renderAnnotation(ctx, anno);
        ctx.restore();
      } else {
        _renderAnnotation(ctx, anno);
      }
    }
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const W   = ctx.canvas.width;
  const H   = ctx.canvas.height;

  if (!_isCacheValid(W, H)) _buildCache(W, H, dpr);

  // Shift the blit by the pan delta since the cache was built.
  // The oversized buffer means this stays fully correct for pan distances
  // up to one full viewport width/height without any rebuild.
  const panDx = (viewport.panX - _cacheVpPanX) * dpr;
  const panDy = (viewport.panY - _cacheVpPanY) * dpr;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(_strokeCache, panDx - _cacheBufX, panDy - _cacheBufY);
  ctx.restore();
}

/** Draws the stroke in progress while the pointer is still held. */
function drawLivePreview(ctx) {
  if (!drawing) return;

  if (snappedData) {
    // Render the snapped shape using its proper geometry
    const w = _shapeWidth(currentWidth);
    if (snappedData.shapeType === 'circle') {
      drawCircle(ctx, snappedData.cx, snappedData.cy, snappedData.r, w, currentColour);
    } else if (snappedData.shapeType === 'ellipse') {
      drawEllipse(ctx, snappedData.cx, snappedData.cy, snappedData.rx, snappedData.ry, w, currentColour);
    } else {
      drawShapePath(ctx, snappedData.idealPoints,
                    snappedData.shapeType === 'rect', w, currentColour);
    }
    // Note: 'corner' and 'line' both use drawShapePath with close=false, handled above
    return;
  }

  if (livePoints.length < 2) return;
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
// Shape rendering helpers
// ---------------------------------------------------------------------------

/**
 * Dispatches to the correct renderer based on anno.shapeType.
 * Falls back to drawPath for normal freehand strokes (no shapeType).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} anno — draw annotation
 */
function _renderAnnotation(ctx, anno) {
  const w = anno.shapeType ? _shapeWidth(anno.strokeWidth) : null;
  switch (anno.shapeType) {
    case 'line':
      drawShapePath(ctx, anno.points, false, w, anno.colour);
      break;
    case 'rect':
      drawShapePath(ctx, anno.points, true, w, anno.colour);
      break;
    case 'corner':
      drawShapePath(ctx, anno.points, false, w, anno.colour);
      break;
    case 'circle':
      drawCircle(ctx, anno.cx, anno.cy, anno.r, w, anno.colour);
      break;
    case 'ellipse':
      drawEllipse(ctx, anno.cx, anno.cy, anno.rx, anno.ry, w, anno.colour);
      break;
    default:
      drawPath(ctx, anno.points, anno.strokeWidth, anno.colour);
  }
}

/**
 * Computes the stroke width for a shape annotation, enforcing a minimum of
 * 1.5 physical pixels regardless of zoom level.
 *
 * @param {number} baseWidth — Canvas-unit stroke width
 * @returns {number}
 */
function _shapeWidth(baseWidth) {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(baseWidth, 1.5 / (viewport.scale * dpr));
}

/**
 * Renders a line or rectangle using straight lineTo segments.
 * For rects, closePath() is called to close the fourth side with a sharp corner.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x,y}>} points    — corner points (2 for line, 4 for rect)
 * @param {boolean} close          — true for rect (closePath), false for line
 * @param {number} width           — stroke width in canvas units
 * @param {string} colour          — CSS colour string
 */
function drawShapePath(ctx, points, close, width, colour) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  if (close) ctx.closePath();
  ctx.strokeStyle = colour;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'miter'; // sharp corners for rectangles
  ctx.stroke();
}

/**
 * Renders a circle using ctx.arc() — geometrically perfect, no bezier distortion.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx     — centre x in canvas units
 * @param {number} cy     — centre y in canvas units
 * @param {number} r      — radius in canvas units
 * @param {number} width  — stroke width in canvas units
 * @param {string} colour — CSS colour string
 */
function drawCircle(ctx, cx, cy, r, width, colour) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.strokeStyle = colour;
  ctx.lineWidth   = width;
  ctx.stroke();
}

/**
 * Renders an axis-aligned ellipse using ctx.ellipse() — geometrically perfect.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx     — centre x in canvas units
 * @param {number} cy     — centre y in canvas units
 * @param {number} rx     — horizontal semi-axis in canvas units
 * @param {number} ry     — vertical semi-axis in canvas units
 * @param {number} width  — stroke width in canvas units
 * @param {string} colour — CSS colour string
 */
function drawEllipse(ctx, cx, cy, rx, ry, width, colour) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
  ctx.strokeStyle = colour;
  ctx.lineWidth   = width;
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
  // When pressure sensitivity is off, use a flat 0.5 (uniform width).
  // When on, clamp to [0.1, 1.0] — some devices report 0 before pen touches surface.
  const rawPressure = pressureSensitive ? (e.pressure || 0.5) : 0.5;
  const pressure = Math.max(0.1, Math.min(1.0, rawPressure));
  return { x, y, pressure };
}


// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initDraw, activate, deactivate, setColour, setStrokeWidth, setPressureSensitive, setShapeSnap };
