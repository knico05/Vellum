/**
 * app.js — Renderer process entry point
 *
 * Initialises all modules in the correct order once the DOM is ready.
 * Import order matters: viewport has no deps, renderer depends on viewport,
 * input depends on both.
 */

'use strict';

import { init as initRenderer } from './canvas/renderer.js';
import { init as initInput    } from './canvas/input.js';

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

// ---------------------------------------------------------------------------
// Module initialisation
// ---------------------------------------------------------------------------

// Renderer creates the <canvas> element and starts the animation loop
initRenderer();

// Input attaches pan/zoom event listeners to #canvas-container
initInput();
