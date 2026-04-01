/**
 * pdfExport.js — Flatten annotations onto PDF pages and export as a new PDF
 *
 * Renders each page (PDF or blank) + its annotations to an offscreen canvas
 * at 2× resolution, then assembles all page images into a PDF using pdf-lib.
 * The result is a standard PDF where annotations are baked in as pixels —
 * it opens in any PDF viewer without needing this app.
 *
 * Annotation types handled:
 *   highlight — semi-transparent bezier stroke (matches highlight.js rendering)
 *   draw      — pressure-sensitive bezier stroke (matches draw.js rendering)
 *   image     — cropped image from dataUrl
 *   note      — plain text rendered with word wrap
 *
 * Coordinate system:
 *   All annotations store coordinates in canvas space. Each page sits at
 *   (page.canvasX, page.canvasY) in canvas space. To draw annotations on the
 *   per-page offscreen canvas we apply:
 *     ctx.scale(EXPORT_SCALE, EXPORT_SCALE)
 *     ctx.translate(-page.canvasX, -page.canvasY)
 *   This maps canvas-space annotation coords to page-local pixel coords.
 *
 * Exports: exportToPdf(onProgress?)
 */

'use strict';

import { getAll }                    from '../annotations/manager.js';
import { getPageList, getPdfDoc }    from '../pages/pageManager.js';
import { PDFDocument }               from '../../node_modules/pdf-lib/dist/pdf-lib.esm.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Resolution multiplier for the offscreen canvas.
 * 2× gives sharp output at both screen and print resolution.
 * Higher values increase file size significantly.
 */
const EXPORT_SCALE = 2;

/**
 * Extra whitespace (in canvas units) added around the annotation/page union
 * when exporting in canvas mode. Keeps annotations from touching the edge.
 */
const CANVAS_EXPORT_PADDING = 40;

/** Padding inside text boxes (canvas units) */
const TEXT_BOX_PADDING = 6;

/** Line height as a multiple of font size */
const LINE_HEIGHT_RATIO = 1.4;

/**
 * Pressure curve exponent — must match draw.js PRESSURE_EXPONENT.
 * Controls how aggressively pressure maps to stroke width.
 */
const PRESSURE_EXPONENT = 0.7;

/**
 * Semi-transparent colours for named highlight presets.
 * Must match the COLOURS map in highlight.js.
 */
const HIGHLIGHT_COLOURS = {
  yellow: 'rgba(255, 213, 79,  0.45)',
  green:  'rgba(72,  199, 116, 0.45)',
  pink:   'rgba(255, 99,  132, 0.45)',
  blue:   'rgba(91,  138, 245, 0.45)',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders all pages with annotations and packages them into a PDF.
 *
 * @param {function(current: number, total: number): void} [onProgress]
 *   Called before each page is rendered, with (pageIndex, totalPages).
 * @param {{ mode: 'pages'|'canvas' }} [options]
 *   mode 'pages'  — export each page at its original dimensions (default).
 *   mode 'canvas' — expand each page to include any annotations drawn in
 *                   the margins, like printing a OneNote notebook.
 * @returns {Promise<Uint8Array>} Raw bytes of the finished PDF file.
 */
async function exportToPdf(onProgress, options = { mode: 'pages' }) {
  const pages  = getPageList();
  const pdfDoc = getPdfDoc();

  if (pages.length === 0) throw new Error('No pages to export.');

  const allAnnotations = getAll();
  const pageImageData  = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    onProgress?.(i, pages.length);

    // In canvas mode, compute the union of the page rect and all annotation
    // bounding boxes, then add padding so nothing touches the edge.
    let exportBounds = null;
    if (options.mode === 'canvas') {
      const annoBounds = _getAnnotationBounds(allAnnotations, page);
      const rawMinX = Math.min(page.canvasX, annoBounds ? annoBounds.minX : page.canvasX);
      const rawMinY = Math.min(page.canvasY, annoBounds ? annoBounds.minY : page.canvasY);
      const rawMaxX = Math.max(page.canvasX + page.width,  annoBounds ? annoBounds.maxX : page.canvasX + page.width);
      const rawMaxY = Math.max(page.canvasY + page.height, annoBounds ? annoBounds.maxY : page.canvasY + page.height);
      exportBounds = {
        minX: rawMinX - CANVAS_EXPORT_PADDING,
        minY: rawMinY - CANVAS_EXPORT_PADDING,
        maxX: rawMaxX + CANVAS_EXPORT_PADDING,
        maxY: rawMaxY + CANVAS_EXPORT_PADDING,
      };
    }

    const pngBytes = await renderPageToPng(page, pdfDoc, allAnnotations, exportBounds);
    const ptWidth  = exportBounds ? (exportBounds.maxX - exportBounds.minX) : page.width;
    const ptHeight = exportBounds ? (exportBounds.maxY - exportBounds.minY) : page.height;
    pageImageData.push({ pngBytes, ptWidth, ptHeight });
  }

  return assemblePdf(pageImageData);
}

// ---------------------------------------------------------------------------
// Annotation bounds helper (canvas mode)
// ---------------------------------------------------------------------------

/**
 * Returns the bounding box (in canvas space) of all annotations for a page.
 * Used in canvas mode to determine how much to expand the export canvas.
 *
 * @param {object[]} annotations — All annotations in the document
 * @param {object}   page        — Page descriptor
 * @returns {{ minX:number, minY:number, maxX:number, maxY:number } | null}
 *   null if the page has no annotations.
 */
function _getAnnotationBounds(annotations, page) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasAny = false;

  for (const a of annotations) {
    if (a.pageId !== page.id) continue;

    if (a.points && a.points.length > 0) {
      // draw / highlight path — iterate all points, expand by half stroke width
      const pad = (a.strokeWidth ?? 0) / 2;
      for (const pt of a.points) {
        minX = Math.min(minX, pt.x - pad);
        minY = Math.min(minY, pt.y - pad);
        maxX = Math.max(maxX, pt.x + pad);
        maxY = Math.max(maxY, pt.y + pad);
      }
      hasAny = true;
    } else if (a.canvasX !== undefined) {
      // image / note / legacy highlight rect
      minX = Math.min(minX, a.canvasX);
      minY = Math.min(minY, a.canvasY);
      maxX = Math.max(maxX, a.canvasX + (a.width  ?? 0));
      maxY = Math.max(maxY, a.canvasY + (a.height ?? 0));
      hasAny = true;
    }
  }

  return hasAny ? { minX, minY, maxX, maxY } : null;
}

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------

/**
 * Renders a single page (PDF content + annotations) to PNG bytes.
 *
 * @param {object} page              — Page descriptor from getPageList()
 * @param {PDFDocumentProxy|null} pdfDoc — PDF.js document proxy (null for blank-only docs)
 * @param {object[]} allAnnotations  — All annotations for the full document
 * @param {{ minX:number, minY:number, maxX:number, maxY:number } | null} exportBounds
 *   When non-null (canvas mode), the output canvas covers this region in canvas space
 *   rather than the page dimensions. The PDF page is composited at the correct offset.
 * @returns {Promise<Uint8Array>} PNG bytes at EXPORT_SCALE resolution
 */
async function renderPageToPng(page, pdfDoc, allAnnotations, exportBounds = null) {
  // Determine the canvas-space region that maps to the output image.
  // Pages mode: exactly the page rectangle.
  // Canvas mode: the pre-computed exportBounds (page ∪ annotations + padding).
  const originX  = exportBounds ? exportBounds.minX : page.canvasX;
  const originY  = exportBounds ? exportBounds.minY : page.canvasY;
  const regionW  = exportBounds ? (exportBounds.maxX - exportBounds.minX) : page.width;
  const regionH  = exportBounds ? (exportBounds.maxY - exportBounds.minY) : page.height;

  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(regionW * EXPORT_SCALE);
  canvas.height = Math.round(regionH * EXPORT_SCALE);
  const ctx = canvas.getContext('2d');

  // White background (blank pages and any transparent areas on PDF pages)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Render PDF page content via PDF.js.
  // In pages mode, PDF.js renders to (0,0) which is exactly right.
  // In canvas mode, the page may be offset within the export region, so we
  // render to a temporary canvas then drawImage it at the correct position.
  if (page.kind === 'pdf' && pdfDoc) {
    if (exportBounds) {
      // Render PDF page to a temp canvas at page size, then stamp it at offset.
      const tmp = document.createElement('canvas');
      tmp.width  = Math.round(page.width  * EXPORT_SCALE);
      tmp.height = Math.round(page.height * EXPORT_SCALE);
      const tmpCtx = tmp.getContext('2d');
      tmpCtx.fillStyle = '#ffffff';
      tmpCtx.fillRect(0, 0, tmp.width, tmp.height);
      const pdfPage = await pdfDoc.getPage(page.pdfPageIndex + 1);
      const vp = pdfPage.getViewport({ scale: EXPORT_SCALE });
      await pdfPage.render({ canvasContext: tmpCtx, viewport: vp }).promise;
      const offsetPx = Math.round((page.canvasX - originX) * EXPORT_SCALE);
      const offsetPy = Math.round((page.canvasY - originY) * EXPORT_SCALE);
      ctx.drawImage(tmp, offsetPx, offsetPy);
    } else {
      const pdfPage = await pdfDoc.getPage(page.pdfPageIndex + 1); // 1-based
      const vp      = pdfPage.getViewport({ scale: EXPORT_SCALE });
      await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
    }
  }

  // Switch to canvas space: annotation coords are stored in canvas space.
  // Translating by -originX/Y maps them to export-region-local coordinates.
  // In pages mode originX/Y === page.canvasX/Y (same as before).
  ctx.save();
  ctx.scale(EXPORT_SCALE, EXPORT_SCALE);
  ctx.translate(-originX, -originY);

  const pageAnnos = allAnnotations.filter(a => a.pageId === page.id);

  // Pre-load all image elements (async, must complete before drawing)
  const imageCache = await preloadImages(pageAnnos);

  // Draw in layer order: highlights → ink → images → text boxes
  drawHighlights(ctx, pageAnnos);
  drawInkStrokes(ctx, pageAnnos);
  await drawImages(ctx, pageAnnos, imageCache);
  drawTextBoxes(ctx, pageAnnos);

  ctx.restore();

  // Export offscreen canvas to PNG bytes
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// PDF assembly
// ---------------------------------------------------------------------------

/**
 * Assembles page PNG images into a single PDF using pdf-lib.
 * Each page is stored at its original point dimensions (1 canvas unit = 1 PDF point)
 * with the PNG embedded at 2× resolution for crisp rendering.
 *
 * @param {Array<{pngBytes: Uint8Array, ptWidth: number, ptHeight: number}>} pages
 * @returns {Promise<Uint8Array>}
 */
async function assemblePdf(pages) {
  const output = await PDFDocument.create();

  for (const { pngBytes, ptWidth, ptHeight } of pages) {
    const img     = await output.embedPng(pngBytes);
    const pdfPage = output.addPage([ptWidth, ptHeight]);
    pdfPage.drawImage(img, { x: 0, y: 0, width: ptWidth, height: ptHeight });
  }

  return output.save();
}

// ---------------------------------------------------------------------------
// Image preloading
// ---------------------------------------------------------------------------

/**
 * Creates and loads all HTMLImageElement instances for image annotations on a page.
 * Returns a Map of annotation id → HTMLImageElement.
 *
 * @param {object[]} pageAnnos
 * @returns {Promise<Map<string, HTMLImageElement>>}
 */
async function preloadImages(pageAnnos) {
  const cache = new Map();
  const loads = pageAnnos
    .filter(a => a.type === 'image' && a.dataUrl)
    .map(async (anno) => {
      const img = new Image();
      img.src   = anno.dataUrl;
      try { await img.decode(); } catch { /* skip unloadable images */ }
      cache.set(anno.id, img);
    });
  await Promise.all(loads);
  return cache;
}

// ---------------------------------------------------------------------------
// Annotation draw routines
// ---------------------------------------------------------------------------

/**
 * Draws all highlight annotations for a page.
 * Handles both new path-based highlights and legacy rect-based highlights.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} annos
 */
function drawHighlights(ctx, annos) {
  for (const anno of annos) {
    if (anno.type !== 'highlight') continue;

    // Resolve colour: named preset → rgba string, or use stored CSS string directly
    const colour = HIGHLIGHT_COLOURS[anno.colour] ?? anno.colour ?? HIGHLIGHT_COLOURS.yellow;

    if (anno.points) {
      // Path-based highlight (new format)
      drawHighlightPath(ctx, anno.points, anno.strokeWidth ?? 16, colour);
    } else {
      // Legacy rect-based highlight
      ctx.fillStyle = colour;
      ctx.fillRect(anno.canvasX, anno.canvasY, anno.width, anno.height);
    }
  }
}

/**
 * Draws all ink stroke annotations for a page.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} annos
 */
function drawInkStrokes(ctx, annos) {
  for (const anno of annos) {
    if (anno.type !== 'draw') continue;
    drawInkPath(ctx, anno.points, anno.strokeWidth, anno.colour);
  }
}

/**
 * Draws all image annotations for a page.
 * Uses the pre-loaded image cache to avoid redundant network/decode operations.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} annos
 * @param {Map<string, HTMLImageElement>} imageCache
 */
async function drawImages(ctx, annos, imageCache) {
  for (const anno of annos) {
    if (anno.type !== 'image') continue;

    const img = imageCache.get(anno.id);
    if (!img || !img.complete || img.naturalWidth === 0) continue;

    // Crop: the visible window is (canvasX, canvasY, width, height).
    // The full image sits at (canvasX - cropX, canvasY - cropY) with size (imgW, imgH).
    ctx.save();
    ctx.beginPath();
    ctx.rect(anno.canvasX, anno.canvasY, anno.width, anno.height);
    ctx.clip();
    ctx.drawImage(
      img,
      anno.canvasX - (anno.cropX ?? 0),
      anno.canvasY - (anno.cropY ?? 0),
      anno.imgW ?? anno.width,
      anno.imgH ?? anno.height,
    );
    ctx.restore();
  }
}

/**
 * Draws all text box annotations for a page.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} annos
 */
function drawTextBoxes(ctx, annos) {
  for (const anno of annos) {
    if (anno.type !== 'note') continue;
    drawTextBox(ctx, anno);
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Renders a highlighter stroke as a smooth quadratic bezier path.
 * Matches the rendering in highlight.js: uniform width, square line caps.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number, y:number}>} points
 * @param {number} width   — Canvas-unit stroke width
 * @param {string} colour  — CSS rgba string
 */
function drawHighlightPath(ctx, points, width, colour) {
  if (!points || points.length < 2) return;

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
  }

  ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);

  ctx.strokeStyle = colour;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'square';
  ctx.lineJoin    = 'round';
  ctx.stroke();
}

/**
 * Renders an ink stroke as a smooth quadratic bezier path.
 * Matches the rendering in draw.js: pressure-based width, round caps.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number, y:number, pressure:number}>} points
 * @param {number} baseWidth — Canvas-unit stroke width at full pressure
 * @param {string} colour    — CSS colour string
 */
function drawInkPath(ctx, points, baseWidth, colour) {
  if (!points || points.length < 2) return;

  // Average pressure → single stroke width per stroke (matches draw.js behaviour)
  const avgPressure   = points.reduce((s, p) => s + (p.pressure ?? 0.5), 0) / points.length;
  const pressureWidth = baseWidth * Math.pow(Math.min(avgPressure * 2, 1), PRESSURE_EXPONENT);

  // At export scale we do not enforce a screen-pixel minimum — the stroke
  // width is already in canvas units and will be scaled up correctly.
  const width = Math.max(pressureWidth, 0.3);

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
  }

  ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);

  ctx.strokeStyle = colour;
  ctx.lineWidth   = width;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.stroke();
}

/**
 * Renders a text box annotation as plain text with word wrapping.
 * Uses the same font stack as the DOM text boxes.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} anno — Note annotation with canvasX/Y, width, height, colour, fontSize, text
 */
function drawTextBox(ctx, anno) {
  const text     = (anno.text ?? '').trim();
  if (!text) return;

  const fontSize   = anno.fontSize ?? 14;
  const colour     = anno.colour   ?? '#000000';
  const maxWidth   = anno.width - TEXT_BOX_PADDING * 2;
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;

  ctx.save();
  ctx.font         = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
  ctx.fillStyle    = colour;
  ctx.textBaseline = 'top';

  const lines = wrapText(ctx, text, maxWidth);

  let y = anno.canvasY + TEXT_BOX_PADDING;
  const maxY = anno.canvasY + anno.height;

  for (const line of lines) {
    if (y + lineHeight > maxY) break; // Clip to box height
    ctx.fillText(line, anno.canvasX + TEXT_BOX_PADDING, y);
    y += lineHeight;
  }

  ctx.restore();
}

/**
 * Wraps text to fit within maxWidth, splitting on whitespace and newlines.
 *
 * @param {CanvasRenderingContext2D} ctx — Needed for measureText()
 * @param {string} text
 * @param {number} maxWidth — Maximum line width in canvas units
 * @returns {string[]} Array of wrapped lines
 */
function wrapText(ctx, text, maxWidth) {
  const lines = [];

  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ');
    let line    = '';

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { exportToPdf };
