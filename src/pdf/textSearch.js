/**
 * textSearch.js — PDF text extraction and full-document search
 *
 * Extracts text from PDF pages via PDF.js getTextContent(), caches results
 * per page, and provides case-insensitive substring search across all pages.
 *
 * Text items returned by PDF.js are grouped into visual lines by proximity
 * of their baseline Y coordinates, then concatenated so multi-item word
 * matches are found correctly.
 *
 * Coordinate conversion:
 *   PDF user space — origin at bottom-left of the page, y increases upward.
 *   Canvas space   — origin at the page's top-left corner, y increases downward.
 *   For a page at canvas (canvasX, canvasY) with height H, a PDF text item
 *   at position (tx, ty) with dimensions (w, h) maps to canvas space:
 *     left   = canvasX + tx
 *     top    = canvasY + (H − ty − h)
 *     right  = canvasX + tx + w
 *     bottom = canvasY + (H − ty)
 *
 * Exports: search, clearCache
 */

'use strict';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Cache of extracted lines, keyed by page id.
 * Each value is an array of line objects (see _extractLines).
 *
 * @type {Map<string, Array<Line>>}
 */
const _pageCache = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clears the text cache. Call this whenever a new PDF is loaded so stale
 * positions from the previous document are not returned.
 */
function clearCache() {
  _pageCache.clear();
}

/**
 * Searches all PDF pages for query string and returns canvas-space match rects.
 *
 * Blank pages are skipped (they have no text content).
 * Returns an empty array if pdfDoc is null or query is empty.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy|null} pdfDoc
 * @param {Array<{id: string, kind: string, pdfPageIndex?: number, canvasX: number, canvasY: number, width: number, height: number}>} pages
 * @param {string} query
 * @returns {Promise<Array<{pageId: string, canvasRect: {x: number, y: number, w: number, h: number}}>>}
 */
async function search(pdfDoc, pages, query) {
  if (!pdfDoc || !query || query.trim().length === 0) return [];

  const q       = query.toLowerCase();
  const matches = [];

  for (const page of pages) {
    if (page.kind !== 'pdf') continue; // blank pages have no text

    const lines = await _extractLines(pdfDoc, page.pdfPageIndex, page);

    for (const line of lines) {
      const text = line.text.toLowerCase();
      let startIdx = 0;

      while (startIdx < text.length) {
        const pos = text.indexOf(q, startIdx);
        if (pos === -1) break;

        const matchEnd = pos + q.length;

        // Collect all items whose character range overlaps with the match
        const spanningItems = line.items.filter(
          item => item.charStart < matchEnd && item.charEnd > pos,
        );

        if (spanningItems.length > 0) {
          matches.push({
            pageId:     page.id,
            canvasRect: _unionRects(spanningItems.map(i => i.canvasRect)),
          });
        }

        // Advance by 1 to allow overlapping matches (e.g. "aa" in "aaa")
        startIdx = pos + 1;
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * @typedef {{ text: string, items: Array<LineItem> }} Line
 * @typedef {{ str: string, charStart: number, charEnd: number, canvasRect: {x,y,w,h} }} LineItem
 */

/**
 * Extracts and caches the text lines for one PDF page.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
 * @param {number} pdfPageIndex — 0-based index within the PDF
 * @param {{ id: string, canvasX: number, canvasY: number, height: number }} pageDesc
 * @returns {Promise<Array<Line>>}
 */
async function _extractLines(pdfDoc, pdfPageIndex, pageDesc) {
  const cached = _pageCache.get(pageDesc.id);
  if (cached) return cached;

  const pdfPage    = await pdfDoc.getPage(pdfPageIndex + 1); // PDF.js is 1-based
  const textContent = await pdfPage.getTextContent();

  const { canvasX, canvasY, height: pageH } = pageDesc;

  // Build raw items with canvas bounding rects.
  // transform = [a, b, c, d, e, f] — e is x, f is baseline y in PDF user space.
  // We ignore shear/rotation (a, b, c, d) and use only the translation (e, f).
  const rawItems = textContent.items
    .filter(item => typeof item.str === 'string' && item.str.length > 0)
    .map(item => {
      const tx = item.transform[4];
      const ty = item.transform[5];
      const w  = item.width  ?? 0;
      const h  = item.height > 0 ? item.height : 10; // fallback for zero-height items

      return {
        str:     item.str,
        pdfY:    ty, // baseline Y in PDF space, used for line grouping
        canvasRect: {
          x: canvasX + tx,
          y: canvasY + (pageH - ty - h),
          w,
          h,
        },
      };
    });

  // Sort by Y descending (topmost in canvas = highest pdfY)
  rawItems.sort((a, b) => b.pdfY - a.pdfY);

  // Group into lines: items whose baseline Y values are within 3 PDF units
  // of the line's reference Y are considered the same line.
  const lineGroups = [];
  for (const item of rawItems) {
    let placed = false;
    for (const group of lineGroups) {
      if (Math.abs(group.refY - item.pdfY) < 3) {
        group.rawItems.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) {
      lineGroups.push({ refY: item.pdfY, rawItems: [item] });
    }
  }

  // Within each line, sort items left-to-right by canvas x
  for (const group of lineGroups) {
    group.rawItems.sort((a, b) => a.canvasRect.x - b.canvasRect.x);
  }

  // Build Line objects: concatenate item strings, track char offsets per item
  const lines = lineGroups.map(group => {
    let lineText = '';
    const items  = [];

    for (const raw of group.rawItems) {
      const charStart = lineText.length;
      lineText += raw.str;
      const charEnd = lineText.length;
      items.push({ str: raw.str, charStart, charEnd, canvasRect: raw.canvasRect });
    }

    return { text: lineText, items };
  });

  _pageCache.set(pageDesc.id, lines);
  return lines;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the smallest axis-aligned rect that encloses all given rects.
 *
 * @param {Array<{x: number, y: number, w: number, h: number}>} rects
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
function _unionRects(rects) {
  const left   = Math.min(...rects.map(r => r.x));
  const top    = Math.min(...rects.map(r => r.y));
  const right  = Math.max(...rects.map(r => r.x + r.w));
  const bottom = Math.max(...rects.map(r => r.y + r.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { search, clearCache };
