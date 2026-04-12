/**
 * serialiser.js — Convert annotation state to/from JSON
 *
 * Pure functions — no I/O, no side effects. Everything that touches disk
 * is in autosave.js. This module only transforms data shapes.
 *
 * File schema (version 2):
 * {
 *   "version": 2,
 *   "format": "quicknotes",
 *   "pdfPath": "/abs/path/lecture.pdf",
 *   "pdfFingerprint": "abc123...",
 *   "updatedAt": "2025-01-15T14:32:00Z",
 *   "pages": [
 *     { "id": "pdf-0",   "kind": "pdf",   "pdfPageIndex": 0 },
 *     { "id": "blank-x", "kind": "blank", "width": 595, "height": 842 },
 *     { "id": "pdf-1",   "kind": "pdf",   "pdfPageIndex": 1 }
 *   ],
 *   "pageNotes":   { "pdf-0": "text…", "blank-x": "text…" },
 *   "pageInkText": { "pdf-0": "velocity gradient laminar…" },
 *   "annotations": [ { …annotation objects with pageId field… } ]
 * }
 *
 * pageInkText — cache of Windows Ink handwriting recognition results, keyed by
 * pageId. Written by the search pipeline the first time a page is searched.
 * Invalidated (key deleted) by manager.js when a draw stroke on that page changes.
 *
 * v1 → v2 migration is handled in deserialise() transparently.
 *
 * Exports: serialise(), deserialise()
 */

'use strict';

const CURRENT_VERSION = 2;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts the current state to a JSON string ready to write to disk.
 *
 * @param {string}   pdfPath     — Absolute path of the source PDF
 * @param {string}   fingerprint — SHA-256 hex digest of the PDF's first 8KB
 * @param {Array}    pageList    — Ordered page list from pageManager.getPageList()
 * @param {object[]} annotations — Array from annotationManager.toJSON()
 * @param {object}   pageNotes       — { [pageId]: text } from panel.getPageNotes()
 * @param {object}   pageInkText     — { [pageId]: string } handwriting recognition cache
 * @param {object}   pageInkSegments — { [pageId]: Array<{text,bounds}> } per-cluster bounds
 * @returns {string} Pretty-printed JSON
 */
function serialise(pdfPath, fingerprint, pageList, annotations, pageNotes = {}, pageInkText = {}, pageInkSegments = {}) {
  // Strip runtime-only fields (canvasX, canvasY, width/height for PDF pages)
  // from the page list before saving — layout is recomputed at load time.
  const savedPages = pageList.map(p => p.kind === 'pdf'
    ? { id: p.id, kind: 'pdf', pdfPageIndex: p.pdfPageIndex }
    : { id: p.id, kind: 'blank', width: p.width, height: p.height, template: p.template ?? 'plain' }
  );

  // Only persist non-empty ink text entries to keep file size minimal
  const inkTextToSave = Object.fromEntries(
    Object.entries(pageInkText).filter(([, v]) => typeof v === 'string' && v.length > 0)
  );

  // Only persist segments for pages that have ink text
  const inkSegmentsToSave = Object.fromEntries(
    Object.entries(pageInkSegments).filter(([k, v]) => inkTextToSave[k] && Array.isArray(v) && v.length > 0)
  );

  return JSON.stringify({
    version:           CURRENT_VERSION,
    format:            'quicknotes',
    pdfPath,
    pdfFingerprint:    fingerprint,
    updatedAt:         new Date().toISOString(),
    pages:             savedPages,
    pageNotes,
    pageInkText:       inkTextToSave,
    pageInkSegments:   inkSegmentsToSave,
    annotations,
  }, null, 2);
}

/**
 * Parses a JSON string from disk back into usable data.
 * Automatically migrates v1 files to the v2 shape.
 *
 * @param {string} jsonString — Raw file contents
 * @returns {{
 *   version: number,
 *   pdfFingerprint: string,
 *   pages: Array|null,
 *   annotations: object[],
 *   pageNotes: object,
 *   _migratedFrom?: number,
 *   _blankPageDescriptors?: Array
 * }}
 * @throws {Error} If the JSON is malformed or missing required fields
 */
function deserialise(jsonString) {
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error('Annotation file is not valid JSON');
  }

  if (typeof data.version !== 'number') {
    throw new Error('Annotation file is missing a version field');
  }

  if (data.version === 1) {
    return _migrateV1(data);
  }

  // Version 2
  return {
    version:        data.version,
    pdfFingerprint: data.pdfFingerprint ?? '',
    pages:          Array.isArray(data.pages) ? data.pages : null,
    annotations:    Array.isArray(data.annotations) ? data.annotations : [],
    pageNotes:      (data.pageNotes && typeof data.pageNotes === 'object')
                      ? data.pageNotes
                      : {},
    pageInkText:     (data.pageInkText && typeof data.pageInkText === 'object')
                       ? data.pageInkText
                       : {},
    pageInkSegments: (data.pageInkSegments && typeof data.pageInkSegments === 'object')
                       ? data.pageInkSegments
                       : {},
  };
}

// ---------------------------------------------------------------------------
// v1 → v2 migration
// ---------------------------------------------------------------------------

/**
 * Converts a parsed v1 annotation file to the v2 data shape.
 *
 * v1 layout:
 *   - annotations[] includes blankPage entries with canvasX/canvasY
 *   - non-blank annotations have pageIndex (integer)
 *   - pageNotes keys are integer strings ("0", "1"...)
 *
 * v2 layout:
 *   - pages[] is a separate ordered list (derived from PDF + blank pages)
 *   - annotations have pageId (string)
 *   - pageNotes keys are pageId strings
 *
 * Because the PDF page dimensions (needed to compute their layout) are not
 * stored in v1 files, the page list cannot be fully built here. Instead:
 *   - pages is returned as null (app.js will use pageManager's default list)
 *   - _blankPageDescriptors is returned so app.js can call
 *     pageManager.spliceBlankPagesFromMigration() after openPDF() runs
 *
 * @param {object} data — Parsed v1 JSON
 * @returns {object} v2-shaped result with migration markers
 */
function _migrateV1(data) {
  const allAnnotations = Array.isArray(data.annotations) ? data.annotations : [];

  // Separate blank-page entries from real annotations
  const blankAnnos = allAnnotations
    .filter(a => a.type === 'blankPage')
    .sort((a, b) => a.canvasY - b.canvasY);

  const regularAnnos = allAnnotations
    .filter(a => a.type !== 'blankPage')
    .map(a => ({
      ...a,
      // Convert integer pageIndex → stable pageId string
      pageId:    `pdf-${a.pageIndex ?? 0}`,
      pageIndex: undefined, // remove old field
    }));

  // Blank page descriptors carry _canvasY so pageManager can splice them
  // into the correct position relative to the PDF pages.
  const blankPageDescriptors = blankAnnos.map(a => ({
    id:      a.id,
    kind:    'blank',
    width:   a.width  ?? 595,
    height:  a.height ?? 842,
    _canvasY: a.canvasY ?? 0, // temporary — used for ordering during migration only
  }));

  // Migrate pageNotes keys: "0" → "pdf-0"
  const pageNotes = {};
  for (const [key, text] of Object.entries(data.pageNotes ?? {})) {
    if (text && typeof text === 'string') {
      pageNotes[/^\d+$/.test(key) ? `pdf-${key}` : key] = text;
    }
  }

  return {
    version:               1,
    _migratedFrom:         1,
    _blankPageDescriptors: blankPageDescriptors,
    pdfFingerprint:        data.pdfFingerprint ?? '',
    pages:                 null, // page list will be built by pageManager
    annotations:           regularAnnos,
    pageNotes,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { serialise, deserialise };
