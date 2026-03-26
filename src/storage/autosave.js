/**
 * autosave.js — Debounced auto-save for annotation state
 *
 * Listens to the 'annotations-changed' event fired by the annotation manager.
 * After 1 second of inactivity (no further changes), writes the full annotation
 * state to a .annotations.json file next to the open PDF.
 *
 * Why debounce?
 *   During freehand drawing, 'annotations-changed' fires once per stroke —
 *   that's fine. But sticky note text fires on every keystroke. Without
 *   debouncing we'd write to disk dozens of times per second while typing.
 *   1000ms delay is imperceptible to the user and reduces disk writes enormously.
 *
 * The save indicator in the toolbar briefly shows "Saved" after each write,
 * then fades out. This gives the user confidence without being distracting.
 *
 * Exports: init()
 */

'use strict';

import { serialise, annotationsPath }      from './serialiser.js';
import { getCurrentPdfPath, getCurrentFingerprint } from '../pdf/pdfManager.js';
import { toJSON }                          from '../annotations/manager.js';
import { getPageNotes }                   from '../ui/panel.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 1000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let saveTimer     = null;
let indicator     = null;
let fadeTimer     = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Starts the auto-save system.
 * Must be called once after the DOM is ready.
 */
function init() {
  indicator = document.getElementById('lbl-save-status');

  // Every annotation change restarts the debounce timer
  document.addEventListener('annotations-changed', scheduleSave);
}

// ---------------------------------------------------------------------------
// Save scheduling
// ---------------------------------------------------------------------------

/**
 * Schedules a save 1 second from now.
 * If called again before the timer fires, resets the clock.
 */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Save execution
// ---------------------------------------------------------------------------

/**
 * Writes the current annotation state to disk.
 * No-ops if no PDF is currently loaded.
 */
async function save() {
  const pdfPath = getCurrentPdfPath();
  if (!pdfPath) return;

  const fingerprint = getCurrentFingerprint() ?? '';
  const annotations = toJSON();
  const savePath    = annotationsPath(pdfPath);

  try {
    const json = serialise(pdfPath, fingerprint, annotations, getPageNotes());
    await window.api.writeFile(savePath, json);
    showSaved();
  } catch (err) {
    console.error('Auto-save failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Save indicator
// ---------------------------------------------------------------------------

/**
 * Briefly shows "Saved" in the toolbar, then fades it out.
 */
function showSaved() {
  if (!indicator) return;

  indicator.textContent = 'Saved';
  indicator.style.opacity = '1';

  // Cancel any in-progress fade, then schedule a new one
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => {
    indicator.style.opacity = '0';
  }, 1200);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initAutosave, scheduleSave };
