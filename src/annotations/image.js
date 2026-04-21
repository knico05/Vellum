/**
 * image.js — Image annotation (DOM overlay approach)
 *
 * Corner handles have two modes:
 *   - Quick drag  → RESIZE: scales the whole image to fit the new size
 *   - Hold 400ms  → CROP:   keeps the image at its current size but trims the
 *                           visible window from that corner (handle turns amber)
 *
 * The image body itself is draggable to move it on the canvas.
 *
 * Annotation schema:
 *   { type:'image', pageIndex, canvasX, canvasY, width, height,
 *     imgW, imgH,      — full (uncropped) image dimensions in canvas units
 *     cropX, cropY,    — offset into the image where the visible window starts
 *     dataUrl }
 *
 * When not cropped: imgW===width, imgH===height, cropX===0, cropY===0.
 * Resize always resets cropX/cropY to 0 and updates imgW/imgH.
 *
 * Paste:
 *   - Ctrl+V         → places image at viewport centre (via pasteImageAtCenter())
 *   - Touch long-press (800ms) on canvas → shows "Paste Image" button
 *
 * Exports: initImages(), addImage(), pasteImageAtCenter()
 */

'use strict';

import { toCanvas, toScreen, state as viewportState } from '../canvas/viewport.js';
import { register, requestRender }                    from '../canvas/renderer.js';
import { add, update, remove, getAll }                from './manager.js';
import { resolvePageId }                              from '../pages/pageManager.js';
import { getDragOffset }                              from './select.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SIZE = 20;

/**
 * Maximum default width (canvas units) for a freshly pasted image.
 * Capped at half a standard PDF page width (~595/2 ≈ 280) so pasted images
 * start at a readable size without overwhelming the canvas. User can resize.
 */
const MAX_PASTE_W = 280;

/** How long a canvas touch must be held (ms) before showing the paste button */
const LONG_PRESS_MS = 800;

/** Max movement (CSS px) allowed during long-press before cancelling */
const LONG_PRESS_MOVE_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let container = null;

/** Map of annotation id → wrapper DOM element */
const imgElements = new Map();

/**
 * Resize/crop state while a corner handle is being dragged.
 * cropMode is set by the per-image crop toggle button, not a timer.
 */
let resizeState = null;

/**
 * Set of annotation IDs that are currently in crop mode.
 * When an image is in crop mode, corner drags crop instead of resize.
 */
const cropModeIds = new Set();

/**
 * Move state while the image body is being dragged.
 */
let moveState = null;

/** Long-press state for canvas paste gesture */
let longPressTimer  = null;
let longPressStartX = 0;
let longPressStartY = 0;

/** The floating "Paste Image" button */
let pasteButtonEl = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  container = document.getElementById('canvas-container');
  document.addEventListener('annotations-changed', syncElements);
  register(updatePositions);

  buildPasteButton();
  initLongPress();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Adds an image annotation at the given canvas position with no initial crop.
 */
function addImage(dataUrl, canvasX, canvasY, width, height, pageId) {
  add({
    type:   'image',
    pageId: pageId ?? resolvePageId(canvasX + width / 2, canvasY + height / 2),
    canvasX, canvasY, width, height,
    imgW:  width,
    imgH:  height,
    cropX: 0,
    cropY: 0,
    dataUrl,
  });
}

/**
 * Reads a clipboard image and places it at the centre of the current viewport.
 * Called by the Ctrl+V handler in app.js.
 */
async function pasteImageAtCenter() {
  const rect   = container.getBoundingClientRect();
  const { x: cx, y: cy } = toCanvas(rect.width / 2, rect.height / 2);
  await _pasteFromClipboard(cx, cy);
}

// ---------------------------------------------------------------------------
// Long-press paste (tablet)
// ---------------------------------------------------------------------------

function buildPasteButton() {
  pasteButtonEl = document.createElement('button');
  pasteButtonEl.id        = 'img-paste-btn';
  pasteButtonEl.className = 'img-paste-btn hidden';
  pasteButtonEl.textContent = '⊕  Paste Image';
  document.body.appendChild(pasteButtonEl);

  pasteButtonEl.addEventListener('click', async () => {
    pasteButtonEl.classList.add('hidden');
    const rect   = container.getBoundingClientRect();
    const { x: cx, y: cy } = toCanvas(
      longPressStartX - rect.left,
      longPressStartY - rect.top,
    );
    await _pasteFromClipboard(cx, cy);
  });

  // Dismiss when tapping anywhere else
  document.addEventListener('pointerdown', (e) => {
    if (!pasteButtonEl.classList.contains('hidden') && !pasteButtonEl.contains(e.target)) {
      pasteButtonEl.classList.add('hidden');
    }
  }, { capture: true });
}

function initLongPress() {
  container.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (e.target.closest('.image-anno')) return;

    longPressStartX = e.clientX;
    longPressStartY = e.clientY;

    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      // Position the button at the hold point
      pasteButtonEl.style.left = `${longPressStartX}px`;
      pasteButtonEl.style.top  = `${longPressStartY}px`;
      pasteButtonEl.classList.remove('hidden');
    }, LONG_PRESS_MS);
  });

  const cancel = () => { clearTimeout(longPressTimer); longPressTimer = null; };

  container.addEventListener('pointermove', (e) => {
    if (!longPressTimer) return;
    const dx = e.clientX - longPressStartX;
    const dy = e.clientY - longPressStartY;
    if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_MOVE_THRESHOLD) cancel();
  });
  container.addEventListener('pointerup',     cancel);
  container.addEventListener('pointercancel', cancel);
}

// ---------------------------------------------------------------------------
// Clipboard paste
// ---------------------------------------------------------------------------

async function _pasteFromClipboard(canvasX, canvasY) {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find(t => t.startsWith('image/'));
      if (!imgType) continue;

      const blob    = await item.getType(imgType);
      const dataUrl = await _blobToDataUrl(blob);
      const { w: natW, h: natH } = await _getImageDimensions(dataUrl);

      // Size the image in canvas units independent of current zoom.
      // At 100% zoom (scale=1) the image will appear at its natural pixel size
      // capped to MAX_PASTE_W — consistent no matter when or where it's pasted.
      const canvasW  = Math.min(natW, MAX_PASTE_W);
      const canvasH  = natH * (canvasW / natW);
      addImage(dataUrl, canvasX - canvasW / 2, canvasY - canvasH / 2, canvasW, canvasH);
      break;
    }
  } catch (err) {
    console.error('Paste image failed:', err);
  }
}

function _blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

function _getImageDimensions(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 200, h: 200 });
    img.src = dataUrl;
  });
}

// ---------------------------------------------------------------------------
// Backward-compat helpers
// ---------------------------------------------------------------------------

function getImgW(anno)  { return anno.imgW  ?? anno.width;  }
function getImgH(anno)  { return anno.imgH  ?? anno.height; }
function getCropX(anno) { return anno.cropX ?? 0; }
function getCropY(anno) { return anno.cropY ?? 0; }

// ---------------------------------------------------------------------------
// DOM ↔ store sync
// ---------------------------------------------------------------------------

function syncElements() {
  const annotations = getAll().filter(a => a.type === 'image');
  const currentIds  = new Set(annotations.map(a => a.id));

  for (const [id, el] of imgElements) {
    if (!currentIds.has(id)) {
      el.remove();
      imgElements.delete(id);
    }
  }

  for (const anno of annotations) {
    if (!imgElements.has(anno.id)) {
      const el = createImageElement(anno);
      container.appendChild(el);
      imgElements.set(anno.id, el);
    } else {
      const el = imgElements.get(anno.id);
      el.style.width  = `${anno.width}px`;
      el.style.height = `${anno.height}px`;
      _applyImgStyle(el, anno);
    }
  }

  updatePositions();
  requestRender();
}

function _applyImgStyle(containerEl, anno) {
  const img = containerEl.querySelector('img');
  if (!img) return;
  const imgW  = getImgW(anno);
  const imgH  = getImgH(anno);
  const cropX = getCropX(anno);
  const cropY = getCropY(anno);
  img.style.width  = `${imgW}px`;
  img.style.height = `${imgH}px`;
  img.style.left   = `${-cropX}px`;
  img.style.top    = `${-cropY}px`;
}

// ---------------------------------------------------------------------------
// Per-frame positioning
// ---------------------------------------------------------------------------

function updatePositions() {
  const byId = new Map(getAll().map(a => [a.id, a]));

  for (const [id, el] of imgElements) {
    const anno = byId.get(id);
    if (!anno) continue;

    const offset   = getDragOffset(id);
    const displayX = anno.canvasX + (offset ? offset.dx : 0);
    const displayY = anno.canvasY + (offset ? offset.dy : 0);
    const { x, y } = toScreen(displayX, displayY);
    // Round translate values to avoid sub-pixel positions that create
    // ghost lines at the clip boundary when zoomed in.
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${viewportState.scale})`;

    // Always sync clip size and inner image position every frame so that
    // crop changes to any edge (including left/top) are reflected immediately.
    el.style.width  = `${anno.width}px`;
    el.style.height = `${anno.height}px`;
    _applyImgStyle(el, anno);
  }
}

// ---------------------------------------------------------------------------
// DOM element factory
// ---------------------------------------------------------------------------

function createImageElement(anno) {
  const el = document.createElement('div');
  el.className  = 'image-anno';
  el.dataset.id = anno.id;
  el.style.cssText = [
    'position: absolute',
    'top: 0',
    'left: 0',
    'transform-origin: top left',
    `width: ${anno.width}px`,
    `height: ${anno.height}px`,
    // z-index is controlled by CSS (.image-anno / #canvas-container[data-tool])
    // so that images sit below the annotation canvas in draw/highlight/eraser mode
    // and above it in select mode (so handles are grabbable).
  ].join('; ');

  // ── Clip wrapper — contains only the image; overflow:hidden clips crop ─────
  // The outer el has overflow:visible so handles and delete button
  // can sit outside the image boundary.
  const clip = document.createElement('div');
  clip.className = 'image-anno-clip';

  const img = document.createElement('img');
  img.src       = anno.dataUrl;
  img.draggable = false;
  img.style.cssText = 'position:absolute;display:block;pointer-events:none;user-select:none;';

  clip.appendChild(img);
  el.appendChild(clip);

  // Apply img size/position AFTER img is in the DOM so querySelector finds it
  _applyImgStyle(el, anno);

  // ── Delete button (outside clip, so not cropped away) ─────────────────────
  const deleteBtn = document.createElement('button');
  deleteBtn.className   = 'image-anno-delete';
  deleteBtn.textContent = '×';
  deleteBtn.title       = 'Delete';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    remove(anno.id);
  });
  el.appendChild(deleteBtn);

  // ── Crop toggle button — lets user switch between resize and crop mode ─────
  const cropBtn = document.createElement('button');
  cropBtn.className = 'image-anno-crop-btn';
  cropBtn.title     = 'Toggle crop mode — drag corners to crop instead of resize';
  cropBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none">
    <path d="M3 1v3H1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M9 11V8h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="3" y="3" width="6" height="6" rx="0.5" stroke="currentColor" stroke-width="1.4"/>
  </svg>`;
  cropBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (cropModeIds.has(anno.id)) {
      cropModeIds.delete(anno.id);
      cropBtn.classList.remove('active');
      // Remove crop-mode class from all handles of this image
      el.querySelectorAll('.image-anno-handle').forEach(h => h.classList.remove('crop-mode'));
    } else {
      cropModeIds.add(anno.id);
      cropBtn.classList.add('active');
      el.querySelectorAll('.image-anno-handle').forEach(h => h.classList.add('crop-mode'));
    }
  });
  el.appendChild(cropBtn);

  // ── Crop handles (4 corners, outside clip) ────────────────────────────────
  const corners = ['tl', 'tr', 'bl', 'br'];
  for (const corner of corners) {
    const h = document.createElement('div');
    h.className = `image-anno-handle image-anno-handle-${corner}`;
    h.addEventListener('pointerdown',   (e) => onHandleDown(e, anno.id, corner, h));
    h.addEventListener('pointermove',   onHandleMove);
    h.addEventListener('pointerup',     (e) => onHandleUp(e, h));
    h.addEventListener('pointercancel', (e) => onHandleUp(e, h));
    el.appendChild(h);
  }

  // ── Move drag on the image body ───────────────────────────────────────────
  el.addEventListener('pointerdown', (e) => {
    // In select mode the select tool owns all drag interactions — it drives
    // movement via getDragOffset() which updatePositions() already reads.
    // Stopping propagation here would prevent select.js from receiving the
    // pointerdown, so its deltaX/deltaY would stay 0 while the image moved
    // via image.js directly, causing the selection box to lag behind.
    if (container.dataset.tool === 'select') return;

    e.stopPropagation(); // prevent canvas pan in draw/cursor/eraser modes
    if (e.target.closest('.image-anno-handle')) return;
    if (e.target.closest('.image-anno-delete')) return;
    if (cropModeIds.has(anno.id)) return; // locked while in crop mode
    onMoveStart(e, anno.id, el);
  });
  el.addEventListener('pointermove',   onMoveMove);
  el.addEventListener('pointerup',     (e) => onMoveEnd(e, el));
  el.addEventListener('pointercancel', (e) => onMoveEnd(e, el));
  el.addEventListener('wheel', (e) => e.stopPropagation());

  return el;
}

// ---------------------------------------------------------------------------
// Move handlers (drag the whole image)
// ---------------------------------------------------------------------------

function onMoveStart(e, annotationId, el) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  el.setPointerCapture(e.pointerId);

  const anno = getAll().find(a => a.id === annotationId);
  moveState = {
    annotationId,
    startCanvasX: anno.canvasX,
    startCanvasY: anno.canvasY,
    startClientX: e.clientX,
    startClientY: e.clientY,
  };
}

function onMoveMove(e) {
  if (!moveState) return;
  const scale = viewportState.scale;
  const dx = (e.clientX - moveState.startClientX) / scale;
  const dy = (e.clientY - moveState.startClientY) / scale;
  update(moveState.annotationId, {
    canvasX: moveState.startCanvasX + dx,
    canvasY: moveState.startCanvasY + dy,
  });
  requestRender();
}

function onMoveEnd(e, el) {
  if (!moveState) return;
  el.releasePointerCapture(e.pointerId);
  moveState = null;
}

// ---------------------------------------------------------------------------
// Resize / crop handlers
// ---------------------------------------------------------------------------

function onHandleDown(e, annotationId, corner, handle) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  e.stopPropagation();
  handle.setPointerCapture(e.pointerId);

  const anno = getAll().find(a => a.id === annotationId);

  // Handles always crop — dragging any corner removes that portion of the image.
  // (Scaling / resize is handled by the select tool's bounding-box handles.)
  resizeState = {
    annotationId,
    corner,
    handle,
    startClientX: e.clientX,
    startClientY: e.clientY,
    cropMode: true,
    startAnno: {
      canvasX: anno.canvasX,
      canvasY: anno.canvasY,
      width:   anno.width,
      height:  anno.height,
      imgW:    getImgW(anno),
      imgH:    getImgH(anno),
      cropX:   getCropX(anno),
      cropY:   getCropY(anno),
    },
  };

  handle.classList.add('crop-mode');
}

function onHandleMove(e) {
  if (!resizeState) return;

  const scale    = viewportState.scale;
  const dxCanvas = (e.clientX - resizeState.startClientX) / scale;
  const dyCanvas = (e.clientY - resizeState.startClientY) / scale;
  const s   = resizeState.startAnno;
  const asp = resizeState.aspect;  // locked aspect ratio
  let changes;

  if (resizeState.cropMode) {
    // ── CROP: keep imgW/imgH fixed, adjust the visible window ────────────
    switch (resizeState.corner) {
      case 'tl': {
        const newCropX = Math.max(0, Math.min(s.cropX + dxCanvas, s.imgW - MIN_SIZE));
        const newCropY = Math.max(0, Math.min(s.cropY + dyCanvas, s.imgH - MIN_SIZE));
        const dcx = newCropX - s.cropX;
        const dcy = newCropY - s.cropY;
        changes = { canvasX: s.canvasX + dcx, canvasY: s.canvasY + dcy,
                    cropX: newCropX, cropY: newCropY,
                    width: Math.max(MIN_SIZE, s.width - dcx),
                    height: Math.max(MIN_SIZE, s.height - dcy) };
        break;
      }
      case 'tr': {
        const newCropY = Math.max(0, Math.min(s.cropY + dyCanvas, s.imgH - MIN_SIZE));
        const dcy = newCropY - s.cropY;
        changes = { canvasY: s.canvasY + dcy, cropY: newCropY,
                    width:  Math.max(MIN_SIZE, Math.min(s.width + dxCanvas, s.imgW - s.cropX)),
                    height: Math.max(MIN_SIZE, s.height - dcy) };
        break;
      }
      case 'bl': {
        const newCropX = Math.max(0, Math.min(s.cropX + dxCanvas, s.imgW - MIN_SIZE));
        const dcx = newCropX - s.cropX;
        changes = { canvasX: s.canvasX + dcx, cropX: newCropX,
                    width:  Math.max(MIN_SIZE, s.width - dcx),
                    height: Math.max(MIN_SIZE, Math.min(s.height + dyCanvas, s.imgH - s.cropY)) };
        break;
      }
      case 'br': {
        changes = { width:  Math.max(MIN_SIZE, Math.min(s.width + dxCanvas, s.imgW - s.cropX)),
                    height: Math.max(MIN_SIZE, Math.min(s.height + dyCanvas, s.imgH - s.cropY)) };
        break;
      }
    }
  } else {
    // ── RESIZE: scale image maintaining original aspect ratio ─────────────
    // Use the x-drag as the primary signal; derive height from locked ratio.
    // Corners that extend left use negative dx to grow the image.
    switch (resizeState.corner) {
      case 'br': {
        const newW = Math.max(MIN_SIZE, s.width + dxCanvas);
        const newH = Math.max(MIN_SIZE, newW / asp);
        changes = { width: newW, height: newH, imgW: newW, imgH: newH, cropX: 0, cropY: 0 };
        break;
      }
      case 'tl': {
        const newW = Math.max(MIN_SIZE, s.width - dxCanvas);
        const newH = Math.max(MIN_SIZE, newW / asp);
        const dcx = s.width  - newW;
        const dcy = s.height - newH;
        changes = { canvasX: s.canvasX + dcx, canvasY: s.canvasY + dcy,
                    width: newW, height: newH, imgW: newW, imgH: newH, cropX: 0, cropY: 0 };
        break;
      }
      case 'tr': {
        const newW = Math.max(MIN_SIZE, s.width + dxCanvas);
        const newH = Math.max(MIN_SIZE, newW / asp);
        const dcy = s.height - newH;
        changes = { canvasY: s.canvasY + dcy,
                    width: newW, height: newH, imgW: newW, imgH: newH, cropX: 0, cropY: 0 };
        break;
      }
      case 'bl': {
        const newW = Math.max(MIN_SIZE, s.width - dxCanvas);
        const newH = Math.max(MIN_SIZE, newW / asp);
        const dcx = s.width - newW;
        changes = { canvasX: s.canvasX + dcx,
                    width: newW, height: newH, imgW: newW, imgH: newH, cropX: 0, cropY: 0 };
        break;
      }
    }
  }

  if (changes) {
    update(resizeState.annotationId, changes);
    requestRender();
  }
}

function onHandleUp(e, handle) {
  if (!resizeState) return;
  handle.releasePointerCapture(e.pointerId);
  resizeState = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Toggles crop mode for the given image annotation ID.
 * Returns true if crop mode is now active, false if deactivated.
 */
function toggleCropMode(id) {
  const el = imgElements.get(id);
  if (cropModeIds.has(id)) {
    cropModeIds.delete(id);
    if (el) {
      el.querySelector('.image-anno-crop-btn')?.classList.remove('active');
      el.querySelectorAll('.image-anno-handle').forEach(h => h.classList.remove('crop-mode'));
    }
    return false;
  } else {
    cropModeIds.add(id);
    if (el) {
      el.querySelector('.image-anno-crop-btn')?.classList.add('active');
      el.querySelectorAll('.image-anno-handle').forEach(h => h.classList.add('crop-mode'));
    }
    return true;
  }
}

/** Returns true if the given image annotation is currently in crop mode. */
function isCropMode(id) { return cropModeIds.has(id); }

export { init as initImages, addImage, pasteImageAtCenter, toggleCropMode, isCropMode };
