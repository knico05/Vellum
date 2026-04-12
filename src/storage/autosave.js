/**
 * autosave.js — Debounced auto-save for annotation state
 *
 * Listens to three events:
 *   'annotations-changed' — ink, highlights, images, sticky notes
 *   'pages-changed'       — blank page inserted or removed
 *   'notes-changed'       — per-page notes text updated
 *
 * After 1 second of inactivity (no further changes), writes the full state
 * to a .annotations.json file next to the open PDF.
 *
 * Why separate events?
 *   'pages-changed' and 'annotations-changed' have different audiences
 *   (panel.js rebuilds on 'pages-changed' but not 'annotations-changed').
 *   Autosave needs to catch all three without caring about the distinction.
 *
 * Exports: init(), scheduleSave()
 */

'use strict';

import { serialise }                                          from './serialiser.js';
import { getCurrentPdfPath, getCurrentFingerprint, getPageList } from '../pages/pageManager.js';
import { toJSON, getPageInkText }                             from '../annotations/manager.js';
import { getPageNotes }                                       from '../ui/panel.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 1000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let saveTimer = null;
let indicator = null;
let fadeTimer = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Starts the auto-save system.
 * Must be called once after the DOM is ready.
 */
function init() {
  indicator = document.getElementById('lbl-save-status');

  document.addEventListener('annotations-changed', scheduleSave);
  document.addEventListener('pages-changed',       scheduleSave);
  document.addEventListener('notes-changed',       scheduleSave);
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
 * Writes the current state to disk.
 * No-ops if no PDF is currently loaded.
 */
async function save() {
  const pdfPath = getCurrentPdfPath();
  if (!pdfPath) return;

  const fingerprint = getCurrentFingerprint() ?? '';
  const pageList    = getPageList();
  const annotations = toJSON();
  const savePath    = await window.api.getAnnotationsPath(pdfPath);

  try {
    const json = serialise(pdfPath, fingerprint, pageList, annotations, getPageNotes(), getPageInkText());
    await window.api.writeFile(savePath, json);
    showSaved();

    // Backup (.vellum) is created on document switch and app quit — not on every
    // save. See app.js backupCurrentNote() for the trigger points.
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

  indicator.textContent   = 'Saved';
  indicator.style.opacity = '1';

  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => {
    indicator.style.opacity = '0';
  }, 1200);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initAutosave, scheduleSave };
