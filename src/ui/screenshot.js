/**
 * screenshot.js — Region screenshot tool
 *
 * When active, a full-window overlay appears. The user drags a rectangle.
 * On release:
 *   1. The overlay is hidden (canvas pointer-events stay disabled until after
 *      capture — this prevents a hovering pen from repainting the canvas
 *      before capturePage fires).
 *   2. Two animation frames are awaited so the overlay paint is fully composited.
 *   3. The full window is captured via IPC (captureScreen).
 *   4. The captured PNG is cropped client-side. Instead of using
 *      window.devicePixelRatio (unreliable on some Windows DPI configurations),
 *      we derive the actual pixel scale from the captured image's natural
 *      dimensions vs the CSS window dimensions.
 *   5. The cropped PNG blob is written to the clipboard only.
 *
 * Pointer handling:
 *   Instead of setPointerCapture (which can be unreliable for pen/touch in
 *   Electron on Windows), we add window-level pointermove/pointerup listeners
 *   during a drag. This matches how the select tool works and is reliable
 *   across all pointer types (mouse, pen, touch).
 *
 * Exports: initScreenshot(), activateScreenshot()
 */

'use strict';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let overlayEl   = null;
let rectEl      = null;
let active      = false;
let dragStart   = null;
let dragCurrent = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function init() {
  overlayEl = document.createElement('div');
  overlayEl.id        = 'screenshot-overlay';
  overlayEl.className = 'hidden';

  const hint = document.createElement('div');
  hint.className   = 'screenshot-hint';
  hint.textContent = 'Drag to capture · Esc to cancel';
  overlayEl.appendChild(hint);

  rectEl = document.createElement('div');
  rectEl.className = 'screenshot-rect hidden';
  overlayEl.appendChild(rectEl);

  document.body.appendChild(overlayEl);

  // Only pointerdown is on the overlay — move/up go on window during drag
  // so they fire regardless of where the pointer moves (reliable for pen/touch)
  overlayEl.addEventListener('pointerdown', onPointerDown);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active) {
      e.stopPropagation(); // prevent global handler from also calling setTool(null)
      deactivate();
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function activate() {
  active      = true;
  dragStart   = null;
  dragCurrent = null;
  rectEl.classList.add('hidden');
  overlayEl.classList.remove('hidden');

  // Keep the canvas completely frozen while the overlay is up.
  // Without this a hovering pen can trigger draw.js and repaint the canvas
  // between "overlay hidden" and "capturePage() completes".
  _disableCanvas();
}

function deactivate() {
  active = false;
  _cleanupWindowListeners();
  overlayEl.classList.add('hidden');
  overlayEl.classList.remove('dragging');
  rectEl.classList.add('hidden');
  dragStart   = null;
  dragCurrent = null;
  _enableCanvas();
}

/** Hides overlay visuals but does NOT restore canvas pointer-events. */
function _hideOverlayOnly() {
  overlayEl.classList.add('hidden');
  overlayEl.classList.remove('dragging');
  rectEl.classList.add('hidden');
  active      = false;
  dragStart   = null;
  dragCurrent = null;
}

function _disableCanvas() {
  const c = document.getElementById('canvas-container');
  if (c) c.style.pointerEvents = 'none';
}

function _enableCanvas() {
  const c = document.getElementById('canvas-container');
  if (c) c.style.pointerEvents = '';
}

function _cleanupWindowListeners() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup',   onPointerUp);
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  e.preventDefault();
  e.stopPropagation();

  dragStart   = { x: e.clientX, y: e.clientY };
  dragCurrent = { x: e.clientX, y: e.clientY };

  rectEl.classList.remove('hidden');
  overlayEl.classList.add('dragging');
  updateRect();

  // Window-level listeners capture all pointer types reliably across platforms.
  // More reliable than setPointerCapture for pen/touch in Electron on Windows.
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup',   onPointerUp);
}

function onPointerMove(e) {
  if (!dragStart) return;
  dragCurrent = { x: e.clientX, y: e.clientY };
  updateRect();
}

async function onPointerUp(e) {
  _cleanupWindowListeners();

  if (!dragStart) return;
  dragCurrent = { x: e.clientX, y: e.clientY };

  // CSS-pixel rect of the selection
  const x = Math.round(Math.min(dragStart.x, dragCurrent.x));
  const y = Math.round(Math.min(dragStart.y, dragCurrent.y));
  const w = Math.round(Math.abs(dragCurrent.x - dragStart.x));
  const h = Math.round(Math.abs(dragCurrent.y - dragStart.y));

  // Hide the overlay so it doesn't appear in the capture.
  // Canvas pointer-events stay DISABLED — a hovering pen must not redraw
  // anything between now and when capturePage() resolves.
  _hideOverlayOnly();

  if (w < 4 || h < 4) {
    _enableCanvas();
    return;
  }

  // Wait for two frames so the overlay's removal is fully composited.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    const pngBytes = await window.api.captureScreen();
    const blob     = await cropPng(pngBytes, x, y, w, h);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    showToast('Screenshot copied — paste to add to canvas');
  } catch (err) {
    console.error('Screenshot failed:', err);
    showToast('Screenshot failed');
  } finally {
    _enableCanvas();
  }
}

// ---------------------------------------------------------------------------
// Client-side crop
// ---------------------------------------------------------------------------

/**
 * Crops a full-window PNG to the given CSS-pixel rect.
 *
 * Instead of using window.devicePixelRatio (which can differ from the actual
 * Electron backing-store scale on Windows HiDPI configurations), we compute
 * the true pixel scale by comparing the captured image's natural dimensions
 * to the CSS window size.
 *
 * @param {Uint8Array} pngBytes  — Full-window PNG from captureScreen
 * @param {number}     cssX      — Left edge in CSS pixels
 * @param {number}     cssY      — Top edge in CSS pixels
 * @param {number}     cssW      — Width in CSS pixels
 * @param {number}     cssH      — Height in CSS pixels
 * @returns {Promise<Blob>}
 */
function cropPng(pngBytes, cssX, cssY, cssW, cssH) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([pngBytes], { type: 'image/png' }));

    img.onload = () => {
      URL.revokeObjectURL(url);

      const scaleX = img.naturalWidth  / window.innerWidth;
      const scaleY = img.naturalHeight / window.innerHeight;

      const px = Math.round(cssX * scaleX);
      const py = Math.round(cssY * scaleY);
      const pw = Math.round(cssW * scaleX);
      const ph = Math.round(cssH * scaleY);

      if (pw < 1 || ph < 1) {
        reject(new Error('Crop area is too small after DPI scaling'));
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width  = pw;
      canvas.height = ph;
      canvas.getContext('2d').drawImage(img, px, py, pw, ph, 0, 0, pw, ph);

      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas.toBlob returned null'));
      }, 'image/png');
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load captured PNG'));
    };

    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function updateRect() {
  if (!dragStart || !dragCurrent) return;
  const x = Math.min(dragStart.x, dragCurrent.x);
  const y = Math.min(dragStart.y, dragCurrent.y);
  const w = Math.abs(dragCurrent.x - dragStart.x);
  const h = Math.abs(dragCurrent.y - dragStart.y);
  rectEl.style.left   = `${x}px`;
  rectEl.style.top    = `${y}px`;
  rectEl.style.width  = `${w}px`;
  rectEl.style.height = `${h}px`;
}

function showToast(message) {
  const el = document.getElementById('lbl-save-status');
  if (!el) return;
  el.textContent   = message;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initScreenshot, activate as activateScreenshot };
