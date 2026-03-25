/**
 * app.js — Renderer process entry point
 *
 * This is the first script that runs in the renderer (browser) context.
 * Its job right now is minimal: wire up the frameless window control buttons.
 *
 * As phases progress, this file will import and initialise the canvas,
 * toolbar, sidebar, and other modules.
 */

'use strict';

// ---------------------------------------------------------------------------
// Title bar window controls
// ---------------------------------------------------------------------------

document.getElementById('btn-minimise').addEventListener('click', () => {
  window.api.windowControl('minimise');
});

document.getElementById('btn-maximise').addEventListener('click', () => {
  window.api.windowControl('maximise');
});

document.getElementById('btn-close').addEventListener('click', () => {
  window.api.windowControl('close');
});
