/**
 * screenshot.js — Region screenshot tool
 *
 * When active, a full-window overlay appears. The user drags a rectangle.
 * On release:
 *   1. The overlay is hidden (so it doesn't appear in the capture).
 *   2. Two animation frames are awaited so the browser paints the hidden state.
 *   3. The full window is captured via IPC (captureScreen).
 *   4. The captured PNG is cropped client-side using a canvas, with the region
 *      scaled by devicePixelRatio to match the physical pixel buffer.
 *   5. The cropped PNG blob is written to the clipboard.
 *
 * Doing the crop client-side avoids the logical/physical pixel mismatch that
 * occurs when passing a rect directly to Electron's capturePage() on HiDPI
 * screens, where the rect would need to be in physical pixels but clientX/Y
 * are in CSS pixels.
 *
 * Exports: initScreenshot(), activateScreenshot()
 */

'use strict';

import { toCanvas, state as viewportState } from '../canvas/viewport.js';
import { addImage }                          from '../annotations/image.js';

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

  overlayEl.addEventListener('pointerdown', onPointerDown);
  overlayEl.addEventListener('pointermove', onPointerMove);
  overlayEl.addEventListener('pointerup',   onPointerUp);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active) deactivate();
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
}

function deactivate() {
  active = false;
  overlayEl.classList.add('hidden');
  overlayEl.classList.remove('dragging');
  rectEl.classList.add('hidden');
  dragStart   = null;
  dragCurrent = null;
}

// ---------------------------------------------------------------------------
// Input handlers
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  dragStart   = { x: e.clientX, y: e.clientY };
  dragCurrent = { x: e.clientX, y: e.clientY };
  rectEl.classList.remove('hidden');
  overlayEl.classList.add('dragging');
  updateRect();
  overlayEl.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!dragStart) return;
  dragCurrent = { x: e.clientX, y: e.clientY };
  updateRect();
}

async function onPointerUp(e) {
  if (!dragStart) return;
  dragCurrent = { x: e.clientX, y: e.clientY };

  // CSS pixel rect of the selection
  const x = Math.round(Math.min(dragStart.x, dragCurrent.x));
  const y = Math.round(Math.min(dragStart.y, dragCurrent.y));
  const w = Math.round(Math.abs(dragCurrent.x - dragStart.x));
  const h = Math.round(Math.abs(dragCurrent.y - dragStart.y));

  // Hide the overlay before capturing so it doesn't appear in the screenshot
  deactivate();

  if (w < 4 || h < 4) return; // Accidental click — ignore

  // Wait for two animation frames so the browser paints the hidden overlay
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    const pngBytes = await window.api.captureScreen();
    const blob     = await cropPng(pngBytes, x, y, w, h);

    // Place on canvas at the canvas-space position of the selection
    const canvasTopLeft = toCanvas(x, y);
    const canvasW = w / viewportState.scale;
    const canvasH = h / viewportState.scale;
    const dataUrl = await blobToDataUrl(blob);
    addImage(dataUrl, canvasTopLeft.x, canvasTopLeft.y, canvasW, canvasH);

    // Also copy to system clipboard
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    showToast('Screenshot added to canvas');
  } catch (err) {
    console.error('Screenshot failed:', err);
    showToast('Screenshot failed');
  }
}

// ---------------------------------------------------------------------------
// Client-side crop
// ---------------------------------------------------------------------------

/**
 * Crops a full-window PNG to the given CSS-pixel rect.
 * Multiplies coordinates by devicePixelRatio because capturePage returns a
 * buffer at physical resolution.
 *
 * @param {Uint8Array} pngBytes  — Full-window PNG from captureScreen
 * @param {number}     cssX      — Left edge in CSS pixels
 * @param {number}     cssY      — Top edge in CSS pixels
 * @param {number}     cssW      — Width in CSS pixels
 * @param {number}     cssH      — Height in CSS pixels
 * @returns {Promise<Blob>}      — Cropped PNG blob
 */
function cropPng(pngBytes, cssX, cssY, cssW, cssH) {
  return new Promise((resolve, reject) => {
    const dpr = window.devicePixelRatio || 1;
    const px  = Math.round(cssX * dpr);
    const py  = Math.round(cssY * dpr);
    const pw  = Math.round(cssW * dpr);
    const ph  = Math.round(cssH * dpr);

    const img = new Image();
    const url = URL.createObjectURL(new Blob([pngBytes], { type: 'image/png' }));

    img.onload = () => {
      URL.revokeObjectURL(url);

      const canvas = document.createElement('canvas');
      canvas.width  = pw;
      canvas.height = ph;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, px, py, pw, ph, 0, 0, pw, ph);

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

/**
 * Converts a Blob to a base64 data URL.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
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
