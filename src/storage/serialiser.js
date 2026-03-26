/**
 * serialiser.js — Convert annotation state to/from JSON
 *
 * Pure functions — no I/O, no side effects. Everything that touches disk
 * is in autosave.js. This module only transforms data shapes.
 *
 * File schema (version 1):
 * {
 *   "version": 1,
 *   "pdfPath": "/abs/path/lecture.pdf",
 *   "pdfFingerprint": "abc123...",    ← SHA-256 of first 8KB
 *   "createdAt": "2025-01-15T14:00:00Z",
 *   "updatedAt": "2025-01-15T14:32:00Z",
 *   "pageNotes": { "0": "text…", "1": "text…" },
 *   "annotations": [ { …annotation objects… } ]
 * }
 *
 * Exports: serialise(), deserialise(), annotationsPath()
 */

'use strict';

const CURRENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Converts the current annotation state to a JSON string ready to write to disk.
 *
 * @param {string}   pdfPath     — Absolute path of the source PDF
 * @param {string}   fingerprint — SHA-256 hex digest of the PDF's first 8KB
 * @param {object[]} annotations — Array from annotationManager.toJSON()
 * @param {object}   pageNotes   — Map of pageIndex → note text (may be empty)
 * @returns {string} Pretty-printed JSON
 */
function serialise(pdfPath, fingerprint, annotations, pageNotes = {}) {
  return JSON.stringify({
    version:        CURRENT_VERSION,
    pdfPath,
    pdfFingerprint: fingerprint,
    updatedAt:      new Date().toISOString(),
    pageNotes,
    annotations,
  }, null, 2);
}

/**
 * Parses a JSON string from disk back into usable data.
 *
 * @param {string} jsonString — Raw file contents
 * @returns {{ version: number, pdfFingerprint: string, annotations: object[], pageNotes: object }}
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

  if (data.version !== CURRENT_VERSION) {
    // Log but don't throw — a future migration path goes here
    console.warn(
      `Annotation file version ${data.version} differs from current version ` +
      `${CURRENT_VERSION}. Loading anyway.`
    );
  }

  return {
    version:        data.version,
    pdfFingerprint: data.pdfFingerprint ?? '',
    annotations:    Array.isArray(data.annotations) ? data.annotations : [],
    pageNotes:      (data.pageNotes && typeof data.pageNotes === 'object')
                      ? data.pageNotes
                      : {},
  };
}

/**
 * Derives the annotations file path from a PDF path.
 * "lecture3.pdf" → "lecture3.annotations.json"
 *
 * @param {string} pdfPath — Absolute path to a PDF file
 * @returns {string}
 */
function annotationsPath(pdfPath) {
  return pdfPath.replace(/\.pdf$/i, '.annotations.json');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { serialise, deserialise, annotationsPath };
