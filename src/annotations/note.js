/**
 * note.js — Text box annotation tool (DOM overlay approach)
 *
 * Text boxes are transparent <div> elements absolutely positioned inside
 * #canvas-container. They pan and zoom with the viewport via CSS transform.
 *
 * z-index: 2 — sits above the annotation canvas (z-index: 1) and PDF pages.
 *
 * Lifecycle:
 *   - Double-click on canvas → creates a new text box at that canvas position
 *   - annotations-changed event → syncElements() creates/removes DOM nodes
 *   - register() callback → updatePositions() repositions all boxes each frame
 *   - Drag the top drag strip → updates canvasX/canvasY in manager
 *   - Click × button → removes annotation from manager
 *   - Focus/blur body → shows/hides inline options bar (colour + size)
 *   - Type in body → debounced save to manager
 *
 * Annotation schema additions vs sticky note:
 *   colour   {string} — CSS hex colour for the text, default '#000000'
 *   fontSize {number} — font size in px (canvas units), default 14
 *
 * Exports: initNotes()
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

const BOX_WIDTH  = 200;
const BOX_HEIGHT = 120;

const MIN_BOX_WIDTH  = 60;
const MIN_BOX_HEIGHT = 32;

const SAVE_DEBOUNCE_MS = 500;

const DEFAULT_COLOUR    = '#000000';
const DEFAULT_FONT_SIZE = 14;

/** All available font sizes for the text box tool */
const FONT_SIZES = [8, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let container = null;

/** True when the text-box tool is active from the toolbar (single-click places a box) */
let toolActive = false;

/** Map of annotation id → DOM element */
const boxElements = new Map();

/** Map of annotation id → pending save setTimeout handle */
const saveTimers = new Map();

/** Active drag state for the top drag strip, or null */
let dragState = null;

/** Active resize state for the bottom-right corner, or null */
let resizeState = null;

/** ID of the annotation whose body currently has focus, or null */
let _focusedAnnoId = null;

/**
 * Default settings for new text boxes. Set by toolbar.js via setNoteDefaults().
 * Persisted to localStorage by toolbar.js.
 */
let _defaults = {
  colour:   DEFAULT_COLOUR,
  fontSize: DEFAULT_FONT_SIZE,
  align:    'left',
};

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/** pointerType of the most recent pointerdown — used to filter click/dblclick by input device */
let lastPointerType = 'mouse';

function init() {
  container = document.getElementById('canvas-container');

  // Track which input device was last used so the click handler can filter by type.
  // Text boxes call stopPropagation on pointerdown, so this only fires when the
  // user presses down OUTSIDE every text box.
  container.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType;

    // Blur any currently editing text box when tapping outside it
    const editingBody = container.querySelector('.text-box.editing .text-box-body');
    if (editingBody) editingBody.blur();
  });

  // Text box created by single click/tap when the N tool is active.
  container.addEventListener('click', onSingleClick);

  document.addEventListener('annotations-changed', (e) => syncElements(e?.detail?.fromLoad ?? false));
  register(updatePositions);
}

/**
 * Activates the text-box tool. A single click/tap (non-pen) places a text box.
 * Called by toolbar.js when the N button is pressed.
 */
function activate() {
  toolActive = true;
  container.classList.add('tool-note');
}

/**
 * Deactivates the text-box tool.
 */
function deactivate() {
  toolActive = false;
  container.classList.remove('tool-note');
}

// ---------------------------------------------------------------------------
// Box creation
// ---------------------------------------------------------------------------

/**
 * Click handler — places a text box only when the N tool is active.
 * Keeps the tool active so the user can keep placing boxes.
 */
function onSingleClick(e) {
  if (!toolActive) return;
  if (lastPointerType === 'pen') return;
  if (e.target.closest('.text-box')) return;
  // If a box is currently focused, this click is exiting it — don't create a new one.
  // _focusedAnnoId is still set here because the blur's 80ms timeout hasn't fired yet.
  if (_focusedAnnoId !== null) return;
  placeBox(e);
}

/**
 * Shared placement logic — creates a text box centred on the click/tap position.
 */
function placeBox(e) {
  const rect     = container.getBoundingClientRect();
  const { x, y } = toCanvas(e.clientX - rect.left, e.clientY - rect.top);
  add({
    type:     'textBox',
    pageId:   resolvePageId(x, y),
    canvasX:  x,
    canvasY:  y,
    width:    BOX_WIDTH,
    height:   BOX_HEIGHT,
    text:     '',
    richText: '',
    colour:   _defaults.colour,
    fontSize: _defaults.fontSize,
    align:    _defaults.align,
  });
}

// ---------------------------------------------------------------------------
// DOM ↔ store synchronisation
// ---------------------------------------------------------------------------

function syncElements(fromLoad = false) {
  const annotations = getAll().filter(a => a.type === 'textBox');
  const currentIds  = new Set(annotations.map(a => a.id));

  for (const [id, el] of boxElements) {
    if (!currentIds.has(id)) {
      el.remove();
      boxElements.delete(id);
      // Clear focused id whenever the annotation it points to is removed —
      // covers × button, Ctrl+Z undo, and auto-delete of empty boxes.
      if (_focusedAnnoId === id) _focusedAnnoId = null;
    }
  }

  for (const anno of annotations) {
    if (!boxElements.has(anno.id)) {
      const el = createBoxElement(anno);
      container.appendChild(el);
      boxElements.set(anno.id, el);

      // Only auto-focus newly placed boxes, not ones restored from a saved file.
      if (!fromLoad) {
        requestAnimationFrame(() => {
          const body = el.querySelector('.text-box-body');
          if (body) body.focus();
        });
      }
    } else {
      const el   = boxElements.get(anno.id);
      const body = el.querySelector('.text-box-body');
      // Never reset innerHTML for the annotation currently being edited —
      // it has unsaved changes and focus may have temporarily moved to the
      // toolbar (e.g. the font-size select). Only reset for other boxes.
      if (body && document.activeElement !== body && anno.id !== _focusedAnnoId) {
        body.innerHTML = _displayHtml(anno);
      }
      applyBodyStyle(el, anno);
      el.style.width  = `${anno.width}px`;
      el.style.height = `${anno.height}px`;
    }
  }

  updatePositions();
  requestRender();
}

// ---------------------------------------------------------------------------
// Per-frame positioning
// ---------------------------------------------------------------------------

function updatePositions() {
  const byId = new Map(getAll().map(a => [a.id, a]));

  for (const [id, el] of boxElements) {
    const anno = byId.get(id);
    if (!anno) continue;

    const offset   = getDragOffset(id);
    const displayX = anno.canvasX + (offset ? offset.dx : 0);
    const displayY = anno.canvasY + (offset ? offset.dy : 0);
    const { x, y } = toScreen(displayX, displayY);
    el.style.transform = `translate(${x}px, ${y}px) scale(${viewportState.scale})`;

    // Sync width/height every frame so live resize preview is reflected immediately.
    const wPx = `${anno.width}px`;
    const hPx = `${anno.height}px`;
    if (el.style.width !== wPx || el.style.height !== hPx) {
      el.style.width  = wPx;
      el.style.height = hPx;
    }
  }
}

// ---------------------------------------------------------------------------
// DOM element factory
// ---------------------------------------------------------------------------

/**
 * Builds the DOM structure for one text box.
 *
 * Structure:
 *   <div class="text-box">
 *     <div class="text-box-drag"></div>
 *     <button class="text-box-delete">×</button>
 *     <div class="text-box-body" contenteditable>…</div>
 *     <div class="text-box-resize"></div>
 *   </div>
 */
function createBoxElement(anno) {
  const el = document.createElement('div');
  el.className  = 'text-box';
  el.dataset.id = anno.id;
  el.style.cssText = [
    'position: absolute',
    'top: 0',
    'left: 0',
    'transform-origin: top left',
    `width: ${anno.width}px`,
    `height: ${anno.height}px`,
    'z-index: 2',
  ].join('; ');

  // ── Drag strip ────────────────────────────────────────────────────────────
  const dragStrip = document.createElement('div');
  dragStrip.className = 'text-box-drag';

  // ── Delete button ─────────────────────────────────────────────────────────
  const deleteBtn = document.createElement('button');
  deleteBtn.className   = 'text-box-delete';
  deleteBtn.textContent = '×';
  deleteBtn.title       = 'Delete';

  // ── Editable body ─────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className       = 'text-box-body';
  body.contentEditable = 'true';
  body.spellcheck      = false;
  body.innerHTML       = _displayHtml(anno);

  // ── Resize handle ─────────────────────────────────────────────────────────
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'text-box-resize';

  el.appendChild(dragStrip);
  el.appendChild(deleteBtn);
  el.appendChild(body);
  el.appendChild(resizeHandle);

  applyBodyStyle(el, anno);

  // ── Event wiring ──────────────────────────────────────────────────────────

  dragStrip.addEventListener('pointerdown', (e) => onDragStart(e, anno.id, dragStrip));
  dragStrip.addEventListener('pointermove',   onDragMove);
  dragStrip.addEventListener('pointerup',     (e) => onDragEnd(e, dragStrip));
  dragStrip.addEventListener('pointercancel', (e) => onDragEnd(e, dragStrip));

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearTimeout(saveTimers.get(anno.id));
    remove(anno.id);
  });

  resizeHandle.addEventListener('pointerdown',   (e) => onResizeStart(e, anno.id, resizeHandle));
  resizeHandle.addEventListener('pointermove',   onResizeMove);
  resizeHandle.addEventListener('pointerup',     (e) => onResizeEnd(e, resizeHandle));
  resizeHandle.addEventListener('pointercancel', (e) => onResizeEnd(e, resizeHandle));

  body.addEventListener('keydown', (e) => {
    // Auto-format: typing "- " at the start of a line converts to a bullet list.
    // Matches the behaviour of most text editors (Notion, Google Docs, etc.).
    if (e.key !== ' ') return;
    const sel = window.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const node  = range.startContainer;
    // Only trigger when the whole text node is exactly "-" and cursor is at the end
    if (node.nodeType !== Node.TEXT_NODE) return;
    if (node.textContent !== '-' || range.startOffset !== 1) return;

    e.preventDefault();
    // Select the entire "-" text node and delete it, then start a bullet list
    const del = document.createRange();
    del.selectNode(node);
    sel.removeAllRanges();
    sel.addRange(del);
    document.execCommand('delete');
    document.execCommand('insertUnorderedList');
    scheduleTextSave(anno.id, body);
  });

  body.addEventListener('input', () => {
    scheduleTextSave(anno.id, body);
    syncHeight(anno.id, el, body);
  });

  body.addEventListener('focus', () => {
    _focusedAnnoId = anno.id;
    el.classList.add('editing');
    // Always switch to the note tool when a text box is focused so the toolbar
    // shows the text box controls regardless of which tool was active before.
    document.dispatchEvent(new CustomEvent('request-note-tool'));
    // Notify toolbar so it can sync its controls to this box's style
    document.dispatchEvent(new CustomEvent('textbox-focus-changed', {
      detail: { annoId: anno.id, style: _getAnnoStyle(anno) },
    }));
  });
  body.addEventListener('blur',  () => {
    // Flush any pending text save immediately — prevents content loss if the
    // user switches documents within the 500ms debounce window.
    const pendingTimer = saveTimers.get(anno.id);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      saveTimers.delete(anno.id);
      update(anno.id, { richText: body.innerHTML, text: body.textContent.trim() });
    }
    setTimeout(() => {
      const ae = document.activeElement;
      // Keep focused state alive when focus moved to the toolbar's textbox options
      // (e.g. clicking the font-size select) so toolbar controls can still apply.
      const inTextBoxOptions = document.getElementById('textbox-options')?.contains(ae);
      if (!el.contains(ae) && !inTextBoxOptions) {
        _focusedAnnoId = null;
        el.classList.remove('editing');
        document.dispatchEvent(new CustomEvent('textbox-focus-changed', { detail: null }));

        // Clear any remaining text selection inside this box — without this,
        // the highlighted text stays visible after the user clicks elsewhere.
        const sel = window.getSelection();
        if (sel && el.contains(sel.anchorNode)) {
          sel.removeAllRanges();
        }

        // Auto-delete empty text boxes so accidental placements don't litter
        // the canvas as invisible annotations.
        if (!body.textContent.trim()) remove(anno.id);
      }
    }, 80);
  });

  // Mouse and pen events must not reach the canvas (would trigger pan/draw).
  // Touch events are allowed to propagate so one-finger pan still works when
  // the user's finger passes over a text box.
  // For touch: double-tap (two taps within 300ms) enters edit mode.
  let _lastTapTime = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') {
      e.stopPropagation();
      return;
    }
    // Double-tap: two taps within 300ms enters edit mode
    const now = Date.now();
    if (now - _lastTapTime < 300) {
      e.stopPropagation(); // prevent canvas pan on second tap
      el.classList.add('editing');
      body.focus();
      // Place cursor at end of content
      const range = document.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      _lastTapTime = 0; // reset to prevent triple-tap triggering again
    } else {
      _lastTapTime = now;
    }
  });
  // Only swallow wheel events when the box itself is scrollable (content
  // exceeds max height). Otherwise let wheel fall through to the canvas
  // so zooming/panning works over non-scrollable boxes.
  el.addEventListener('wheel', (e) => {
    if (el.classList.contains('scrollable')) e.stopPropagation();
  });

  return el;
}

// ---------------------------------------------------------------------------
// External API — called by toolbar.js
// ---------------------------------------------------------------------------

/**
 * Sets the default settings applied to newly created text boxes.
 * Called by toolbar.js when the user changes a text tool option.
 *
 * @param {{ colour?: string, fontSize?: number, align?: string }} opts
 */
function setNoteDefaults(opts) {
  Object.assign(_defaults, opts);
}

/**
 * Applies style changes to the currently focused text box annotation.
 * Also updates the DOM immediately for live feedback.
 *
 * @param {{ colour?: string, fontSize?: number, align?: string }} style
 */
function applyFocusedStyle(style) {
  if (!_focusedAnnoId) return;
  const el   = boxElements.get(_focusedAnnoId);
  const body = el?.querySelector('.text-box-body');
  if (!body) return;

  if (style.colour !== undefined) {
    // Apply to current selection or insertion point — NOT to the whole box.
    // We do NOT call update({ colour }) here because that would trigger
    // syncElements → applyBodyStyle → body.style.color, changing the whole box.
    // Instead we use execCommand and save the resulting HTML via richText.
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, style.colour);
    scheduleTextSave(_focusedAnnoId, body);
  }
  if (style.fontSize !== undefined) {
    body.style.fontSize = `${style.fontSize}px`;
    // Flush current HTML alongside fontSize so richText is never stale when
    // syncElements runs (triggered by annotations-changed from update()).
    update(_focusedAnnoId, { fontSize: style.fontSize, richText: body.innerHTML, text: body.textContent.trim() });
  }
  if (style.align    !== undefined) { body.style.textAlign = style.align;             update(_focusedAnnoId, { align:    style.align    }); }
}

/** Returns the ID of the annotation whose body is currently focused, or null. */
function getFocusedAnnoId() {
  return _focusedAnnoId;
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

/**
 * Applies the annotation's colour and fontSize to the body element.
 * Called during sync and on initial creation.
 *
 * @param {HTMLElement} boxEl
 * @param {object}      anno
 */
function applyBodyStyle(boxEl, anno) {
  const body = boxEl.querySelector('.text-box-body');
  if (!body) return;
  body.style.color     = anno.colour    ?? DEFAULT_COLOUR;
  body.style.fontSize  = `${anno.fontSize ?? DEFAULT_FONT_SIZE}px`;
  body.style.textAlign = anno.align     ?? 'left';
}

/** Returns the style properties of an annotation for toolbar sync. */
function _getAnnoStyle(anno) {
  return {
    colour:   anno.colour   ?? DEFAULT_COLOUR,
    fontSize: anno.fontSize ?? DEFAULT_FONT_SIZE,
    align:    anno.align    ?? 'left',
  };
}

// ---------------------------------------------------------------------------
// Drag handlers
// ---------------------------------------------------------------------------

function onDragStart(e, annotationId, strip) {
  if (e.button !== 0) return;
  e.preventDefault();

  strip.setPointerCapture(e.pointerId);
  strip.style.cursor = 'grabbing';

  const anno = getAll().find(a => a.id === annotationId);
  dragState = {
    annotationId,
    startCanvasX: anno.canvasX,
    startCanvasY: anno.canvasY,
    startClientX: e.clientX,
    startClientY: e.clientY,
  };
}

function onDragMove(e) {
  if (!dragState) return;

  const scale = viewportState.scale;
  const dx    = (e.clientX - dragState.startClientX) / scale;
  const dy    = (e.clientY - dragState.startClientY) / scale;

  update(dragState.annotationId, {
    canvasX: dragState.startCanvasX + dx,
    canvasY: dragState.startCanvasY + dy,
  });
  requestRender();
}

function onDragEnd(e, strip) {
  if (!dragState) return;
  strip.releasePointerCapture(e.pointerId);
  strip.style.cursor = '';
  dragState = null;
}

// ---------------------------------------------------------------------------
// Resize handlers
// ---------------------------------------------------------------------------

function onResizeStart(e, annotationId, handle) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  handle.setPointerCapture(e.pointerId);
  const anno = getAll().find(a => a.id === annotationId);
  resizeState = { annotationId, canvasX: anno.canvasX, canvasY: anno.canvasY };
}

function onResizeMove(e) {
  if (!resizeState) return;

  const rect     = container.getBoundingClientRect();
  const { x, y } = toCanvas(e.clientX - rect.left, e.clientY - rect.top);

  update(resizeState.annotationId, {
    width:  Math.max(MIN_BOX_WIDTH,  x - resizeState.canvasX),
    height: Math.max(MIN_BOX_HEIGHT, y - resizeState.canvasY),
  });
  requestRender();
}

function onResizeEnd(e, handle) {
  if (!resizeState) return;
  handle.releasePointerCapture(e.pointerId);
  resizeState = null;
}

// ---------------------------------------------------------------------------
// Text persistence
// ---------------------------------------------------------------------------

/**
 * Grows or shrinks the text box to fit its current content.
 *
 * body.scrollHeight always returns the full content height regardless of
 * the element's overflow setting, so we can use it to measure needed space.
 * The drag strip (8px) is the only non-body content that contributes to the
 * container height (options bar and delete/resize buttons are absolute).
 */
const DRAG_STRIP_H = 8;

/**
 * Maximum height a text box can auto-grow to (canvas units).
 * Beyond this the body scrolls rather than the box growing indefinitely.
 * ~35 lines of 14px text at scale=1. User can still resize manually past this.
 */
const MAX_BOX_HEIGHT = 500;

function syncHeight(annotationId, containerEl, bodyEl) {
  const uncapped = Math.max(MIN_BOX_HEIGHT, bodyEl.scrollHeight + DRAG_STRIP_H);
  const needed   = Math.min(uncapped, MAX_BOX_HEIGHT);
  const current  = getAll().find(a => a.id === annotationId)?.height ?? 0;
  if (Math.abs(needed - current) < 1) return; // no meaningful change

  // Update DOM immediately for smooth feel, then persist to the store
  containerEl.style.height = `${needed}px`;
  update(annotationId, { height: needed });

  // When the content exceeds the cap, switch the body to scrollable so text
  // isn't silently clipped. Class is toggled each sync so it tracks content.
  containerEl.classList.toggle('scrollable', uncapped > MAX_BOX_HEIGHT);
}

/**
 * Returns the HTML to set as body.innerHTML for the given annotation.
 * Prefers anno.richText (new format — raw innerHTML with inline spans for colour,
 * bold, etc.). Falls back to deserializeText(anno.text) for annotations saved
 * before richText was introduced (plain-text format).
 *
 * @param {object} anno
 * @returns {string}
 */
function _displayHtml(anno) {
  if (anno.richText !== undefined && anno.richText !== null) return anno.richText;
  return deserializeText(anno.text);
}

/**
 * Converts a contenteditable element's innerHTML to plain text preserving
 * newlines. Handles <br>, <div>, and <li> tags produced by Chromium's editor.
 * Bullet lists (<ul>/<li>) are serialised as "• item" lines.
 *
 * @param {HTMLElement} el
 * @returns {string}
 */
function serializeText(el) {
  // Clone so we can manipulate without affecting the live DOM.
  const clone = el.cloneNode(true);

  // Convert list items to "• item" lines before stripping tags.
  for (const li of clone.querySelectorAll('li')) {
    li.replaceWith('• ' + li.textContent + '\n');
  }
  // Remove now-empty ul/ol wrappers.
  for (const list of clone.querySelectorAll('ul, ol')) {
    list.replaceWith(list.textContent);
  }

  return clone.innerHTML
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<div>/gi, '\n')
    .replace(/<\/div>/gi, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '');
}

/**
 * Converts a plain-text string (with \n for newlines) back to safe HTML for
 * setting as innerHTML of a contenteditable element.
 *
 * Lines beginning with "• " (the bullet prefix written by serializeText) are
 * reconstructed into proper <ul><li> elements so that:
 *   1. They render as browser-native bullet list items, and
 *   2. The browser's contenteditable list-continuation logic treats them as
 *      real list items — pressing Enter creates a new <li>, not a stray <div>.
 *
 * @param {string} text
 * @returns {string}
 */
function deserializeText(text) {
  if (!text) return '';

  // Escape HTML-special characters first
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines = escaped.split('\n');
  let html   = '';
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('\u2022 ')) {
      // Bullet line — open a <ul> if not already inside one, then emit <li>
      if (!inList) {
        html   += '<ul>';
        inList  = true;
      }
      html += `<li>${line.slice(2)}</li>`;
    } else {
      // Plain line — close any open list first
      if (inList) {
        html   += '</ul>';
        inList  = false;
      }
      // Last line needs no trailing <br> (contenteditable adds one implicitly)
      html += line + (i < lines.length - 1 ? '<br>' : '');
    }
  }
  if (inList) html += '</ul>';

  return html;
}

function scheduleTextSave(annotationId, bodyEl) {
  clearTimeout(saveTimers.get(annotationId));
  const timer = setTimeout(() => {
    update(annotationId, {
      richText: bodyEl.innerHTML,           // HTML — preserves inline colours, bold, etc.
      text:     bodyEl.textContent.trim(),  // plain text — used for search and empty-check
    });
    saveTimers.delete(annotationId);
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(annotationId, timer);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init as initNotes, activate, deactivate, setNoteDefaults, applyFocusedStyle, getFocusedAnnoId, FONT_SIZES };
