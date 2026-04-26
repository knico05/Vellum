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

import { state as viewport } from '../canvas/viewport.js';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Minimum number of recorded points required for detection */
const MIN_POINTS = 5;

/** Line: max ratio of mean perpendicular distance to line length */
const LINE_THRESHOLD = 0.15;

/** Rect: max ratio of mean nearest-edge distance to min(W, H) */
const RECT_THRESHOLD = 0.22;

/**
 * Rect: a side is "covered" if at least one point lands within this fraction
 * of min(W, H) from that edge. Prevents a straight line from matching as a rect.
 */
const RECT_COVERAGE_FRACTION = 0.2;

/**
 * Rect: minimum number of corners required. A true rectangle has 3–4 sharp turns;
 * smooth curves and L-shapes have fewer. Requiring at least 3 prevents circles and
 * open arcs from being mis-detected as rectangles.
 */
const RECT_MIN_CORNERS = 2;

/**
 * Corner (L-shape): the two segments must meet at an angle within this many
 * degrees of 90°. Used to distinguish a right-angle from an oblique V-shape.
 */
const CORNER_RIGHT_ANGLE_TOLERANCE_DEG = 40;

/**
 * Circle: max ratio of stddev of distances to mean radius.
 * A rectangle scores ~0.14–0.20 on this metric; hand-drawn circles score ~0–0.10.
 * 0.24 is permissive enough for imperfect hand-drawn circles while still rejecting
 * clear rectangles when combined with the corner-count discriminator.
 */
const CIRCLE_THRESHOLD = 0.28;

/**
 * Corner discriminator: angle threshold in degrees.
 * Direction changes sharper than this count as a "corner".
 * Circles have 0–2 corners; rectangles have 3–4.
 */
const CORNER_ANGLE_THRESHOLD_DEG = 40;

/**
 * Maximum corners allowed for a shape to be recognised as a circle.
 * Raised to 2 to accommodate hand-tremor micro-corners without letting
 * rectangles (which always score 3–4) through.
 */
const CIRCLE_MAX_CORNERS = 2;

/** Circle: minimum mean radius in screen pixels (canvas units × scale) */
const CIRCLE_MIN_RADIUS_PX = 12;

/**
 * Circle: points must span at least this many degrees of arc.
 * Lowered from 270 to 240 so users don't need to draw a nearly-complete circle
 * before it snaps — a 2/3 arc is sufficient for clear intent.
 */
const CIRCLE_MIN_ARC_DEG = 210;

/**
 * Ellipse: minimum bounding-box aspect ratio (long/short) for a shape to be
 * tested as an ellipse rather than a circle. Below this threshold the circle
 * detector handles it; at or above it we fit an axis-aligned ellipse.
 */
const ELLIPSE_ASPECT_THRESHOLD = 1.4;


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
  // Minimum size guard in screen pixels so small shapes at high zoom still snap
  const screenExtent = Math.max(maxX - minX, maxY - minY) * viewport.scale;
  if (screenExtent < 20) return null;

  // Order matters: circle/ellipse before rect, because both pass the rect
  // nearest-edge test (points lie close to all 4 edges of the bounding box).
  // Ellipse is checked after circle: if the bounding box is nearly square,
  // circle wins; if it is clearly elongated, ellipse wins.
  // Corner (L-shape) is checked before rect: it has exactly one sharp turn
  // and would otherwise partially match the rect edge test.
  return _detectLine(points)
      ?? _detectCircle(points, minX, minY, maxX, maxY)
      ?? _detectEllipse(points, minX, minY, maxX, maxY)
      ?? _detectCorner(points)
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
  if (len * viewport.scale < 20) return null;  // 20 screen pixels minimum

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

  // Return the straight line from start to end — no angle correction here.
  // Axis snapping happens later during snap-adjust (see axisSnapEndpoint),
  // giving the user sticky H/V feedback as they reposition the endpoint.
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

  // Require at least RECT_MIN_CORNERS sharp direction changes.
  // Circles and arcs have 0–2 corners; true rectangles have 3–4.
  if (_countCorners(points) < RECT_MIN_CORNERS) return null;

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
 *   1. Aspect-ratio guard: if the bounding box is clearly elongated
 *      (long/short ≥ ELLIPSE_ASPECT_THRESHOLD), let _detectEllipse handle it.
 *   2. Corner check: reject if the stroke has > CIRCLE_MAX_CORNERS sharp turns
 *      (distinguishes smooth circles from rectangles / jagged paths).
 *   3. Centroid = mean of all points.
 *   4. Mean radius r = mean distance from centroid.
 *   5. Roundness: stddev(distances) / r < CIRCLE_THRESHOLD.
 *   6. Coverage: the angle range covered by the points must be ≥ CIRCLE_MIN_ARC_DEG.
 *
 * @param {Array<{x,y}>} points
 * @param {number} minX
 * @param {number} minY
 * @param {number} maxX
 * @param {number} maxY
 * @returns {{ shapeType, cx, cy, r } | null}
 */
function _detectCircle(points, minX, minY, maxX, maxY) {
  // Let _detectEllipse handle clearly elongated bounding boxes
  const W = maxX - minX;
  const H = maxY - minY;
  const aspect = W > H ? W / H : H / W;
  if (aspect >= ELLIPSE_ASPECT_THRESHOLD) return null;

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

  if (r * viewport.scale < CIRCLE_MIN_RADIUS_PX) return null;

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
// Ellipse detection
// ---------------------------------------------------------------------------

/**
 * Tests whether the points approximate an axis-aligned ellipse.
 *
 * Called only when the bounding-box aspect ratio ≥ ELLIPSE_ASPECT_THRESHOLD,
 * meaning the shape is clearly elongated and a perfect circle cannot fit.
 *
 * Method:
 *   1. Corner check: reject if too many sharp turns (not a smooth curve).
 *   2. Fit an axis-aligned ellipse to the bounding box:
 *      cx = midpoint X, cy = midpoint Y, rx = half-width, ry = half-height.
 *   3. For each point, compute the normalised distance from the ellipse perimeter:
 *      d = sqrt((dx/rx)² + (dy/ry)²) — equals 1.0 on the ellipse boundary.
 *   4. Mean and stddev of these distances must be close to 1.0.
 *   5. Arc coverage: same angular check as the circle detector.
 *
 * @param {Array<{x,y}>} points
 * @param {number} minX
 * @param {number} minY
 * @param {number} maxX
 * @param {number} maxY
 * @returns {{ shapeType, cx, cy, rx, ry } | null}
 */
function _detectEllipse(points, minX, minY, maxX, maxY) {
  const W = maxX - minX;
  const H = maxY - minY;
  if (W < 20 || H < 20) return null;

  // Reject jagged strokes — smooth ellipses have few sharp direction changes
  if (_countCorners(points) > CIRCLE_MAX_CORNERS) return null;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = W / 2;
  const ry = H / 2;

  // Normalised distances — on the ellipse boundary these equal 1.0
  const normDists = points.map(p => {
    const nx = (p.x - cx) / rx;
    const ny = (p.y - cy) / ry;
    return Math.sqrt(nx * nx + ny * ny);
  });

  const mean = normDists.reduce((s, d) => s + d, 0) / normDists.length;
  // Mean should be close to 1.0 (points lie on the ellipse perimeter)
  if (Math.abs(mean - 1.0) > 0.25) return null;

  const variance = normDists.reduce((s, d) => s + (d - mean) ** 2, 0) / normDists.length;
  const stddev   = Math.sqrt(variance);
  // Low stddev means points are consistently on the perimeter
  if (stddev / mean > CIRCLE_THRESHOLD) return null;

  // Arc coverage — reuse angular check from circle detector
  const angles = points.map(p => Math.atan2(p.y - cy, p.x - cx));
  angles.sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < angles.length; i++) {
    maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
  }
  maxGap = Math.max(maxGap, (angles[0] + 2 * Math.PI) - angles[angles.length - 1]);
  const arcCoveredDeg = (2 * Math.PI - maxGap) * (180 / Math.PI);
  if (arcCoveredDeg < CIRCLE_MIN_ARC_DEG) return null;

  return { shapeType: 'ellipse', cx, cy, rx, ry };
}

// ---------------------------------------------------------------------------
// Corner (L-shape) detection
// ---------------------------------------------------------------------------

/**
 * Tests whether the points form an L-shape: two straight segments meeting at
 * approximately a right angle. This is the most common shape used for drawing
 * graph axes (x-axis + y-axis).
 *
 * Method:
 *   1. Find the single sharpest corner in the stroke (the vertex of the L).
 *   2. Split points into two segments at that vertex.
 *   3. Each segment must be roughly straight (like _detectLine).
 *   4. The angle between the two segments must be within
 *      CORNER_RIGHT_ANGLE_TOLERANCE_DEG of 90°.
 *
 * @param {Array<{x,y}>} points
 * @returns {{ shapeType, idealPoints } | null}
 */
/**
 * Tests whether the points form an L-shape: two straight segments meeting at
 * approximately a right angle. Snaps to a PERFECT axis-aligned L (one segment
 * exactly horizontal, one exactly vertical) — matching the common use case of
 * drawing graph axes.
 *
 * Method:
 *   1. Find the single sharpest corner in the stroke (the vertex of the L).
 *   2. Split points into two segments at that vertex.
 *   3. Each segment must be approximately straight.
 *   4. The segments must meet at roughly 90°.
 *   5. Determine which segment is "more horizontal" and which is "more vertical".
 *   6. Snap: horizontal segment gets its Y locked to the vertex Y;
 *            vertical segment gets its X locked to the vertex X.
 *      Result: a geometrically perfect right-angle with axis-aligned arms.
 *
 * @param {Array<{x,y}>} points
 * @returns {{ shapeType, idealPoints } | null}
 */
function _detectCorner(points) {
  if (points.length < 6) return null;

  const MIN_SEG   = 8;
  const cosThresh = Math.cos(CORNER_ANGLE_THRESHOLD_DEG * Math.PI / 180);

  // Build direction vectors at MIN_SEG spacing, tracking original point index
  const dirs = [];
  let prev    = points[0];
  for (let i = 1; i < points.length; i++) {
    const dx  = points[i].x - prev.x;
    const dy  = points[i].y - prev.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len >= MIN_SEG) {
      dirs.push({ dx: dx / len, dy: dy / len, idx: i });
      prev = points[i];
    }
  }

  if (dirs.length < 3) return null;

  // Find the sharpest direction change
  let sharpestDot = 1;
  let sharpestDirIdx = -1;
  for (let i = 1; i < dirs.length; i++) {
    const dot = dirs[i - 1].dx * dirs[i].dx + dirs[i - 1].dy * dirs[i].dy;
    if (dot < sharpestDot) {
      sharpestDot    = dot;
      sharpestDirIdx = i;
    }
  }

  // Must be a genuinely sharp turn
  if (sharpestDot >= cosThresh) return null;

  const vertexIdx = dirs[sharpestDirIdx].idx;
  const seg1      = points.slice(0, vertexIdx + 1);
  const seg2      = points.slice(vertexIdx);

  if (seg1.length < 3 || seg2.length < 3) return null;

  // Both segments must be approximately straight
  function segStraight(pts) {
    const a   = pts[0];
    const b   = pts[pts.length - 1];
    const dx  = b.x - a.x;
    const dy  = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len * viewport.scale < 8) return false;  // 8 screen pixels minimum per segment
    const nx = -dy / len;
    const ny =  dx / len;
    let sum = 0;
    for (const p of pts) {
      sum += Math.abs((p.x - a.x) * nx + (p.y - a.y) * ny);
    }
    return (sum / pts.length) / len <= LINE_THRESHOLD * 1.5;
  }

  if (!segStraight(seg1) || !segStraight(seg2)) return null;

  const v  = points[vertexIdx];
  const p1 = points[0];
  const p2 = points[points.length - 1];

  // Check angle at vertex is approximately 90°
  const d1x = p1.x - v.x, d1y = p1.y - v.y;
  const d2x = p2.x - v.x, d2y = p2.y - v.y;
  const l1  = Math.sqrt(d1x * d1x + d1y * d1y);
  const l2  = Math.sqrt(d2x * d2x + d2y * d2y);
  if (l1 < 1 || l2 < 1) return null;

  const dot      = (d1x * d2x + d1y * d2y) / (l1 * l2);
  const angleDeg = Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);
  if (Math.abs(angleDeg - 90) > CORNER_RIGHT_ANGLE_TOLERANCE_DEG) return null;

  // Snap to axis-aligned L: classify each segment as more H or more V,
  // then lock the constrained axis to the vertex coordinates.
  // seg1 goes from p1 → v; seg2 goes from v → p2.
  const seg1isH = Math.abs(v.x - p1.x) >= Math.abs(v.y - p1.y);

  let snapStart, snapCorner, snapEnd;
  if (seg1isH) {
    // seg1 horizontal → lock Y to v.y; seg2 vertical → lock X to v.x
    snapStart  = { x: p1.x, y: v.y,  pressure: 0.5 };
    snapCorner = { x: v.x,  y: v.y,  pressure: 0.5 };
    snapEnd    = { x: v.x,  y: p2.y, pressure: 0.5 };
  } else {
    // seg1 vertical → lock X to v.x; seg2 horizontal → lock Y to v.y
    snapStart  = { x: v.x,  y: p1.y, pressure: 0.5 };
    snapCorner = { x: v.x,  y: v.y,  pressure: 0.5 };
    snapEnd    = { x: p2.x, y: v.y,  pressure: 0.5 };
  }

  return {
    shapeType:   'corner',
    idealPoints: [snapStart, snapCorner, snapEnd],
  };
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

/**
 * Snaps a line endpoint to the nearest axis (H or V) if it falls within
 * AXIS_SNAP_DEG degrees of that axis.  Used during snap-adjust mode so the
 * line "sticks" when the user drags near perfectly horizontal or vertical —
 * the visual pause as the endpoint stops moving is the alignment feedback.
 *
 * @param {{ x:number, y:number }} p0   — Fixed start point of the line
 * @param {{ x:number, y:number }} rawPt — Current pen position (canvas space)
 * @returns {{ x:number, y:number }}    — Snapped (or original) endpoint
 */
function axisSnapEndpoint(p0, rawPt) {
  const dx = rawPt.x - p0.x;
  const dy = rawPt.y - p0.y;
  if (dx === 0 && dy === 0) return rawPt;

  // Threshold: snap only when the line is very close to H or V.
  // Tight enough that it only kicks in when the user is intentionally aligning.
  const AXIS_SNAP_DEG = 1;

  // atan2 gives -180…180. Take the absolute value to get 0…180.
  // distToH = distance to the nearest horizontal axis (0° or ±180°).
  // distToV = distance to the nearest vertical axis (±90°).
  // Using absolute angle avoids the mod-90 ambiguity where 90° folds back to
  // 0° and the snap incorrectly switches from vertical to horizontal.
  const absAngle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI); // 0–180
  const distToH  = Math.min(absAngle, 180 - absAngle); // dist to 0° or 180°
  const distToV  = Math.abs(90 - absAngle);             // dist to 90°

  const nearest = distToH < distToV ? 'H' : 'V';
  const dist    = Math.min(distToH, distToV);

  if (dist < AXIS_SNAP_DEG) {
    if (nearest === 'H') return { x: rawPt.x, y: p0.y }; // lock y
    return { x: p0.x, y: rawPt.y };                       // lock x
  }
  return rawPt;
}

export { detectShape, axisSnapEndpoint };
