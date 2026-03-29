/**
 * shape.js — Post-stroke shape recognition for line, rectangle, and circle
 *
 * Called by draw.js after the user holds the pen stationary for ~500ms.
 * If the stroke's points match a known shape within confidence thresholds,
 * returns a set of idealised replacement points. Otherwise returns null.
 *
 * No new annotation type is created — the result is a normal 'draw' annotation
 * whose points happen to be geometrically perfect.
 *
 * Detection order (first match wins):
 *   1. Line   — points lie close to a straight line between the endpoints
 *   2. Circle — points lie close to a circle centred at their centroid
 *   3. Rect   — points lie close to the perimeter of their bounding box
 *
 * Circle is checked before rect because a circular stroke passes the rect
 * nearest-edge test (points lie near all 4 sides of their bounding box).
 * Corner-counting (see _countCorners) is used as an additional discriminator:
 * circles have 0–1 sharp turns; rectangles have 3–4.
 *
 * All idealised points use pressure: 0.5 (neutral, no variable width).
 *
 * Exports: detectShape(points)
 */

'use strict';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Minimum number of recorded points required for detection */
const MIN_POINTS = 5;

/** Minimum bounding-box extent (max of W, H) required — filters out tiny taps */
const MIN_EXTENT = 30;

/** Line: max ratio of mean perpendicular distance to line length */
const LINE_THRESHOLD = 0.08;

/** Rect: max ratio of mean nearest-edge distance to min(W, H) */
const RECT_THRESHOLD = 0.15;

/**
 * Rect: a side is "covered" if at least one point lands within this fraction
 * of min(W, H) from that edge. Prevents a straight line from matching as a rect.
 */
const RECT_COVERAGE_FRACTION = 0.2;

/**
 * Circle: max ratio of stddev of distances to mean radius.
 * A rectangle scores ~0.14–0.20 on this metric; hand-drawn circles score ~0–0.10.
 * 0.18 is permissive enough for imperfect circles while still rejecting rectangles
 * when combined with the corner-count discriminator.
 */
const CIRCLE_THRESHOLD = 0.18;

/**
 * Corner discriminator: angle threshold in degrees.
 * Direction changes sharper than this count as a "corner".
 * Circles have 0–1 corners; rectangles have 3–4.
 */
const CORNER_ANGLE_THRESHOLD_DEG = 40;

/** Maximum corners allowed for a shape to be recognised as a circle. */
const CIRCLE_MAX_CORNERS = 1;

/** Circle: minimum mean radius in canvas units */
const CIRCLE_MIN_RADIUS = 15;

/** Circle: points must span at least this many degrees of arc */
const CIRCLE_MIN_ARC_DEG = 270;


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempts to recognise the freehand stroke as a line, rectangle, or circle.
 *
 * @param {Array<{x: number, y: number, pressure: number}>} points
 *   The recorded stroke points in canvas space.
 * @returns {{ shapeType: string, idealPoints: Array<{x,y,pressure}> } | null}
 *   Detected shape with idealised replacement points, or null if no match.
 */
function detectShape(points) {
  if (points.length < MIN_POINTS) return null;

  const { minX, minY, maxX, maxY } = _bounds(points);
  const extent = Math.max(maxX - minX, maxY - minY);
  if (extent < MIN_EXTENT) return null;

  // Order matters: circle before rect, because a circle passes the rect
  // nearest-edge test (points lie close to all 4 edges of the bounding box).
  return _detectLine(points)
      ?? _detectCircle(points)
      ?? _detectRect(points, minX, minY, maxX, maxY)
      ?? null;
}

// ---------------------------------------------------------------------------
// Line detection
// ---------------------------------------------------------------------------

/**
 * Tests whether the points approximate a straight line between their endpoints.
 *
 * Method: compute the perpendicular distance from each point to the line
 * defined by the first and last recorded point. If the mean distance is less
 * than LINE_THRESHOLD × line length, it's a line.
 *
 * @param {Array<{x,y}>} points
 * @returns {{ shapeType, idealPoints } | null}
 */
function _detectLine(points) {
  const p0 = points[0];
  const p1 = points[points.length - 1];

  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < MIN_EXTENT) return null;

  // Unit normal to the line
  const nx = -dy / len;
  const ny =  dx / len;

  let sumPerp = 0;
  for (const p of points) {
    const ex = p.x - p0.x;
    const ey = p.y - p0.y;
    sumPerp += Math.abs(ex * nx + ey * ny);
  }
  const meanPerp = sumPerp / points.length;

  if (meanPerp / len > LINE_THRESHOLD) return null;

  return {
    shapeType:   'line',
    idealPoints: [
      { x: p0.x, y: p0.y, pressure: 0.5 },
      { x: p1.x, y: p1.y, pressure: 0.5 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Rectangle detection
// ---------------------------------------------------------------------------

/**
 * Tests whether the points approximate the perimeter of their bounding box.
 *
 * Method:
 *   1. For each point, compute distance to the nearest of the 4 edges.
 *   2. Mean of those distances / min(W, H) must be below RECT_THRESHOLD.
 *   3. Coverage check: at least one point must be near each of the 4 edges,
 *      preventing a diagonal line from matching as a very thin rectangle.
 *
 * @param {Array<{x,y}>} points
 * @param {number} minX
 * @param {number} minY
 * @param {number} maxX
 * @param {number} maxY
 * @returns {{ shapeType, idealPoints } | null}
 */
function _detectRect(points, minX, minY, maxX, maxY) {
  const W = maxX - minX;
  const H = maxY - minY;
  if (W < 20 || H < 20) return null;

  const minSide         = Math.min(W, H);
  const coverageThresh  = minSide * RECT_COVERAGE_FRACTION;

  let sumDist        = 0;
  let covTop         = false;
  let covBottom      = false;
  let covLeft        = false;
  let covRight       = false;

  for (const p of points) {
    const dTop    = Math.abs(p.y - minY);
    const dBottom = Math.abs(p.y - maxY);
    const dLeft   = Math.abs(p.x - minX);
    const dRight  = Math.abs(p.x - maxX);

    const nearest = Math.min(dTop, dBottom, dLeft, dRight);
    sumDist += nearest;

    if (dTop    < coverageThresh) covTop    = true;
    if (dBottom < coverageThresh) covBottom = true;
    if (dLeft   < coverageThresh) covLeft   = true;
    if (dRight  < coverageThresh) covRight  = true;
  }

  const meanDist = sumDist / points.length;
  if (meanDist / minSide > RECT_THRESHOLD) return null;
  if (!covTop || !covBottom || !covLeft || !covRight) return null;

  // 4 corners only — closePath() handles the closing segment in the renderer
  return {
    shapeType: 'rect',
    idealPoints: [
      { x: minX, y: minY, pressure: 0.5 }, // TL
      { x: maxX, y: minY, pressure: 0.5 }, // TR
      { x: maxX, y: maxY, pressure: 0.5 }, // BR
      { x: minX, y: maxY, pressure: 0.5 }, // BL
    ],
  };
}

// ---------------------------------------------------------------------------
// Circle detection
// ---------------------------------------------------------------------------

/**
 * Counts the number of sharp direction changes in a stroke.
 *
 * Method: sample direction vectors at intervals of MIN_SEG canvas units,
 * then count consecutive pairs whose dot product falls below the cosine of
 * CORNER_ANGLE_THRESHOLD_DEG. Circles score 0–1; rectangles score 3–4.
 *
 * @param {Array<{x,y}>} points
 * @returns {number}
 */
function _countCorners(points) {
  const MIN_SEG  = 8; // minimum spacing between sampled points (canvas units)
  const cosThresh = Math.cos(CORNER_ANGLE_THRESHOLD_DEG * Math.PI / 180);

  // Build direction vectors at MIN_SEG spacing
  const dirs = [];
  let prev = points[0];
  for (let i = 1; i < points.length; i++) {
    const dx  = points[i].x - prev.x;
    const dy  = points[i].y - prev.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len >= MIN_SEG) {
      dirs.push({ dx: dx / len, dy: dy / len });
      prev = points[i];
    }
  }

  let corners = 0;
  for (let i = 1; i < dirs.length; i++) {
    const dot = dirs[i - 1].dx * dirs[i].dx + dirs[i - 1].dy * dirs[i].dy;
    if (dot < cosThresh) corners++;
  }
  return corners;
}

/**
 * Tests whether the points approximate a circle.
 *
 * Method:
 *   1. Corner check: reject if the stroke has > CIRCLE_MAX_CORNERS sharp turns
 *      (distinguishes smooth circles from rectangles / jagged paths).
 *   2. Centroid = mean of all points.
 *   3. Mean radius r = mean distance from centroid.
 *   4. Roundness: stddev(distances) / r < CIRCLE_THRESHOLD.
 *   5. Coverage: the angle range covered by the points must be ≥ CIRCLE_MIN_ARC_DEG.
 *
 * @param {Array<{x,y}>} points
 * @returns {{ shapeType, idealPoints } | null}
 */
function _detectCircle(points) {
  // Reject strokes with too many sharp corners — they are not circles
  if (_countCorners(points) > CIRCLE_MAX_CORNERS) return null;

  // Centroid
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  cx /= points.length;
  cy /= points.length;

  // Distances from centroid
  const dists = points.map(p => Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2));
  const r     = dists.reduce((s, d) => s + d, 0) / dists.length;

  if (r < CIRCLE_MIN_RADIUS) return null;

  // Roundness check
  const variance = dists.reduce((s, d) => s + (d - r) ** 2, 0) / dists.length;
  const stddev   = Math.sqrt(variance);
  if (stddev / r > CIRCLE_THRESHOLD) return null;

  // Arc coverage check — collect all angles, find gaps
  const angles = points.map(p => Math.atan2(p.y - cy, p.x - cx));
  angles.sort((a, b) => a - b);

  // Find the largest angular gap between consecutive angles
  let maxGap = 0;
  for (let i = 1; i < angles.length; i++) {
    maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
  }
  // Wrap-around gap
  maxGap = Math.max(maxGap, (angles[0] + 2 * Math.PI) - angles[angles.length - 1]);

  const arcCoveredDeg = (2 * Math.PI - maxGap) * (180 / Math.PI);
  if (arcCoveredDeg < CIRCLE_MIN_ARC_DEG) return null;

  // Return centre + radius directly — renderer uses ctx.arc() for a perfect circle
  return { shapeType: 'circle', cx, cy, r };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the axis-aligned bounding box of a set of points.
 *
 * @param {Array<{x,y}>} points
 * @returns {{ minX, minY, maxX, maxY }}
 */
function _bounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { detectShape };
