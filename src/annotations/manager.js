/**
 * manager.js — In-memory annotation state (single source of truth)
 *
 * This module is a pure data store. It has no knowledge of the DOM, the
 * canvas, or the viewport. Other modules interact with it like this:
 *
 *   Tools      → call add() / remove() / update() to mutate state
 *   Renderer   → calls getByPage() / getAll() to read state for drawing
 *   Storage    → calls toJSON() to serialise, loadFromJSON() to restore
 *
 * After every mutation, an 'annotations-changed' CustomEvent is fired on
 * document so any interested module can react (e.g. trigger a re-render,
 * schedule an auto-save).
 *
 * Annotation ID format: "anno_{timestamp}_{6 random chars}"
 * This is unique enough for a local single-user app without needing a UUID lib.
 *
 * Exports: add(), remove(), update(), batchUpdate(), getByPage(), getAll(),
 *          loadFromJSON(), toJSON(), clear(), undo(), redo(),
 *          getPageInkText(), setPageInkText(), loadPageInkText(), isPageInkDirty(), clearPageInkDirty()
 */

'use strict';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Master array of all annotation objects for the current document */
let annotations = [];

// ---------------------------------------------------------------------------
// Handwriting recognition cache
// ---------------------------------------------------------------------------

/**
 * { [pageId]: string } — cached recognition text per page.
 * Persisted. Cleared when any draw stroke on the page changes.
 */
let _pageInkText = {};

/**
 * { [pageId]: Array<{text:string, bounds:{minX,maxX,minY,maxY}}> }
 * Per-cluster recognition segments for the page, used to highlight
 * matched areas on the canvas after a search.
 */
let _pageInkSegments = {};

/**
 * Set of pageIds whose draw strokes have changed since the last recognition run.
 * The search UI reads this to decide which pages need fresh recognition.
 */
const _dirtyInkPages = new Set();

// ---------------------------------------------------------------------------
// Undo stack
// ---------------------------------------------------------------------------

/**
 * Stack of reversible actions. Each entry is one of:
 *   { action: 'add',    id, annotation }          — undo removes; redo re-adds
 *   { action: 'remove', annotation }              — undo re-inserts; redo removes
 *   { action: 'move',   undo: patches, redo: patches } — undo/redo apply position patches
 *   { action: 'group',  entries: [...] }          — compound action (e.g. one eraser stroke)
 *
 * Maximum 50 entries. When full, the oldest entry is dropped.
 * Any new user action (add/remove/move) clears the redo stack.
 */
const MAX_UNDO = 50;
let undoStack = [];

/**
 * Stack of actions that can be redone after an undo. Mirrors undoStack format.
 * Cleared whenever the user performs a new annotation action.
 */
let redoStack = [];

/**
 * When non-null, all add/remove calls are collected into this array instead of
 * being pushed directly onto undoStack. Callers wrap a logical operation in
 * beginUndoGroup() / endUndoGroup() so it appears as a single Ctrl+Z step.
 *
 * Example: one eraser stroke may remove many annotations — beginUndoGroup() is
 * called on pointerdown and endUndoGroup() on pointerup, so the whole stroke
 * undoes atomically.
 */
let _groupBuffer = null;

// ---------------------------------------------------------------------------
// Ink-cache invalidation
// ---------------------------------------------------------------------------

/**
 * Marks a page's ink recognition cache as stale if the annotation is a draw stroke.
 * Called on add, remove, and update so the search pipeline re-recognises that page.
 *
 * @param {object} annotation — the annotation being mutated
 */
function _invalidateInkCache(annotation) {
  if (annotation?.type !== 'draw' || !annotation.pageId) return;
  _pageInkText[annotation.pageId]     = undefined;
  _pageInkSegments[annotation.pageId] = undefined;
  _dirtyInkPages.add(annotation.pageId);
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generates a unique annotation ID.
 * Format: "anno_<unix ms>_<6 random alphanumeric chars>"
 *
 * @returns {string}
 */
function generateId() {
  const ts     = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `anno_${ts}_${random}`;
}

// ---------------------------------------------------------------------------
// Event helper
// ---------------------------------------------------------------------------

/**
 * Fires 'annotations-changed' on document.
 * Listeners receive no detail — they should re-query the manager for state.
 */
function emit() {
  document.dispatchEvent(new CustomEvent('annotations-changed'));
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Adds a new annotation to the store.
 * Generates an ID and timestamps automatically — callers should not set these.
 *
 * @param {object} partial — All annotation fields except id, createdAt, updatedAt
 * @returns {object} The completed annotation object (with generated id/timestamps)
 */
function add(partial) {
  const now = new Date().toISOString();
  const annotation = {
    ...partial,
    id:        generateId(),
    createdAt: now,
    updatedAt: now,
  };
  annotations.push(annotation);
  _invalidateInkCache(annotation);

  // Record for undo — store full annotation so redo can re-insert it exactly.
  // If a group is open, collect into the buffer; otherwise push directly.
  const undoEntry = { action: 'add', id: annotation.id, annotation };
  if (_groupBuffer !== null) {
    _groupBuffer.push(undoEntry);
  } else {
    undoStack.push(undoEntry);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
  }

  emit();
  return annotation;
}

/**
 * Removes an annotation by ID.
 * No-ops silently if the ID is not found.
 *
 * @param {string} id
 */
function remove(id) {
  const target = annotations.find(a => a.id === id);
  if (!target) return; // Not found — no-op

  // Record for undo BEFORE removing, so we can restore the full object.
  // If a group is open, collect into the buffer; otherwise push directly.
  const undoEntry = { action: 'remove', annotation: { ...target } };
  if (_groupBuffer !== null) {
    _groupBuffer.push(undoEntry);
  } else {
    undoStack.push(undoEntry);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
  }

  annotations = annotations.filter(a => a.id !== id);
  _invalidateInkCache(target);
  emit();
}

/**
 * Updates fields on an existing annotation (partial patch).
 * Always refreshes updatedAt.
 *
 * Used for: moving sticky notes, editing note text, changing colour.
 *
 * @param {string} id      — ID of the annotation to update
 * @param {object} changes — Fields to merge in (shallow)
 */
function update(id, changes) {
  const idx = annotations.findIndex(a => a.id === id);
  if (idx === -1) return; // Not found — no-op

  const before = annotations[idx];
  annotations[idx] = {
    ...before,
    ...changes,
    id:        before.id,        // ID is immutable
    createdAt: before.createdAt, // createdAt is immutable
    updatedAt: new Date().toISOString(),
  };
  // Invalidate ink cache if the stroke points changed (not just position/colour)
  if (changes.points !== undefined) _invalidateInkCache(annotations[idx]);
  emit();
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns all annotations for a specific page, in insertion order.
 *
 * @param {string} pageId — Page ID string (e.g. "pdf-0", "blank-abc")
 * @returns {object[]}
 */
function getByPage(pageId) {
  return annotations.filter(a => a.pageId === pageId);
}

/**
 * Returns all annotations for the current document, in insertion order.
 *
 * @returns {object[]}
 */
function getAll() {
  return annotations.slice(); // Shallow copy — callers must not mutate
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Replaces the in-memory state with data loaded from a JSON file.
 * Called by the storage module when opening a PDF that has saved annotations.
 *
 * @param {object[]} loadedAnnotations — Array from the parsed JSON file
 */
function loadFromJSON(loadedAnnotations) {
  if (!Array.isArray(loadedAnnotations)) {
    console.warn('manager.loadFromJSON: expected array, got', typeof loadedAnnotations);
    annotations = [];
  } else {
    annotations = loadedAnnotations.slice();
  }
  // fromLoad: true tells note.js not to auto-focus restored text boxes
  document.dispatchEvent(new CustomEvent('annotations-changed', { detail: { fromLoad: true } }));
}

/**
 * Returns a serialisable snapshot of all annotations.
 * Called by the storage module when saving to disk.
 *
 * @returns {object[]}
 */
function toJSON() {
  return annotations.slice();
}

/**
 * Removes all annotations and resets the undo stack.
 * Called when a new PDF is opened (replacing the previous document).
 */
function clear() {
  const hadContent = annotations.length > 0;
  annotations  = [];
  undoStack        = [];
  redoStack        = [];
  _pageInkText     = {};
  _pageInkSegments = {};
  _dirtyInkPages.clear();
  if (hadContent) emit();
}

/**
 * Reverses the most recent add, remove, or move action, and pushes the
 * inverse onto the redo stack so the action can be reapplied.
 *
 * No-ops silently if the stack is empty.
 */
function undo() {
  if (undoStack.length === 0) return;

  const entry = undoStack.pop();

  if (entry.action === 'add') {
    // Undo add → remove. Store full annotation on redo stack so it can be re-added.
    const removed = annotations.find(a => a.id === entry.id) ?? entry.annotation;
    annotations = annotations.filter(a => a.id !== entry.id);
    redoStack.push({ action: 'add', id: removed.id, annotation: removed });
    emit();
  } else if (entry.action === 'remove') {
    // Undo remove → re-insert. Redo will remove it again.
    annotations.push(entry.annotation);
    redoStack.push({ action: 'remove', annotation: entry.annotation });
    emit();
  } else if (entry.action === 'move') {
    // Undo move → restore before-positions using the stored undo patches.
    applyPatches(entry.undo);
    redoStack.push({ action: 'move', undo: entry.undo, redo: entry.redo });
    emit();
  } else if (entry.action === 'group') {
    // Undo group → reverse each sub-entry in reverse order (LIFO), build redo group.
    const redoEntries = [];
    for (let i = entry.entries.length - 1; i >= 0; i--) {
      const sub = entry.entries[i];
      if (sub.action === 'add') {
        const removed = annotations.find(a => a.id === sub.id) ?? sub.annotation;
        annotations = annotations.filter(a => a.id !== sub.id);
        redoEntries.push({ action: 'add', id: removed.id, annotation: removed });
      } else if (sub.action === 'remove') {
        annotations.push(sub.annotation);
        redoEntries.push({ action: 'remove', annotation: sub.annotation });
      }
    }
    redoStack.push({ action: 'group', entries: redoEntries });
    emit();
  }
}

/**
 * Reapplies the most recently undone action.
 * No-ops silently if the redo stack is empty.
 */
function redo() {
  if (redoStack.length === 0) return;

  const entry = redoStack.pop();

  if (entry.action === 'add') {
    // Redo add → re-insert the annotation.
    annotations.push(entry.annotation);
    undoStack.push({ action: 'add', id: entry.annotation.id, annotation: entry.annotation });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    emit();
  } else if (entry.action === 'remove') {
    // Redo remove → delete the annotation again.
    undoStack.push({ action: 'remove', annotation: entry.annotation });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    annotations = annotations.filter(a => a.id !== entry.annotation.id);
    emit();
  } else if (entry.action === 'move') {
    // Redo move → re-apply the after-positions using the stored redo patches.
    applyPatches(entry.redo);
    undoStack.push({ action: 'move', undo: entry.undo, redo: entry.redo });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    emit();
  } else if (entry.action === 'group') {
    // Redo group → re-apply each sub-entry in original order, build undo group.
    const undoEntries = [];
    for (const sub of entry.entries) {
      if (sub.action === 'add') {
        annotations.push(sub.annotation);
        undoEntries.push({ action: 'add', id: sub.annotation.id, annotation: sub.annotation });
      } else if (sub.action === 'remove') {
        undoEntries.push({ action: 'remove', annotation: sub.annotation });
        annotations = annotations.filter(a => a.id !== sub.annotation.id);
      }
    }
    undoStack.push({ action: 'group', entries: undoEntries });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    emit();
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Deep-clones an array of {id, changes} patches so that stored undo/redo
 * entries are not affected by later mutations to the points arrays.
 *
 * @param {Array<{id:string, changes:object}>} patches
 * @returns {Array<{id:string, changes:object}>}
 */
function deepClonePatches(patches) {
  return patches.map(({ id, changes }) => ({
    id,
    changes: changes.points
      ? { ...changes, points: changes.points.map(p => ({ ...p })) }
      : { ...changes },
  }));
}

/**
 * Applies an array of {id, changes} patches to the annotations array.
 * Does not emit — callers are responsible for emitting after calling this.
 *
 * @param {Array<{id:string, changes:object}>} patches
 */
function applyPatches(patches) {
  const now = new Date().toISOString();
  for (const { id, changes } of patches) {
    const idx = annotations.findIndex(a => a.id === id);
    if (idx === -1) continue;
    annotations[idx] = {
      ...annotations[idx],
      ...changes,
      id:        annotations[idx].id,
      createdAt: annotations[idx].createdAt,
      updatedAt: now,
    };
  }
}

/**
 * Applies multiple position updates in one operation, emitting a single
 * 'annotations-changed' event. Used by the select tool to commit a drag move.
 *
 * Pass undoPatch (the before-state) to enable undo/redo for the move.
 * New user actions (even moves) clear the redo stack.
 *
 * @param {Array<{id: string, changes: object}>} updates   — new positions to apply
 * @param {Array<{id: string, changes: object}>} [undoPatch] — old positions for undo
 */
function batchUpdate(updates, undoPatch = null) {
  if (undoPatch) {
    undoStack.push({
      action: 'move',
      undo: deepClonePatches(undoPatch),
      redo: deepClonePatches(updates),
    });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
  }
  applyPatches(updates);
  emit();
}

/**
 * Opens an undo group. All add() and remove() calls until endUndoGroup() is
 * called will be collected and committed as a single undoable action.
 *
 * Intended for multi-step operations like a single eraser stroke, where many
 * annotations may be removed but the user expects one Ctrl+Z to restore them all.
 *
 * Nested calls are safe: if a group is already open, this is a no-op.
 */
function beginUndoGroup() {
  if (_groupBuffer === null) _groupBuffer = [];
}

/**
 * Closes the current undo group and pushes all collected entries as a single
 * 'group' action onto the undo stack.
 *
 * If the buffer is empty (no mutations occurred during the group), nothing is
 * pushed — avoids cluttering the stack with empty actions.
 *
 * Clears the redo stack since a new user action has been completed.
 */
function endUndoGroup() {
  if (_groupBuffer === null) return;
  const entries = _groupBuffer;
  _groupBuffer  = null;
  if (entries.length === 0) return;
  undoStack.push({ action: 'group', entries });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
}

// ---------------------------------------------------------------------------
// Ink recognition cache — public API
// ---------------------------------------------------------------------------

/**
 * Returns the full pageInkText map for serialisation.
 * @returns {{ [pageId]: string }}
 */
function getPageInkText() {
  return { ..._pageInkText };
}

/**
 * Restores the ink text cache from a loaded annotation file.
 * Called by app.js alongside loadFromJSON() when opening a document.
 *
 * @param {{ [pageId]: string }} map
 */
function loadPageInkText(map) {
  _pageInkText = (map && typeof map === 'object') ? { ...map } : {};
  _dirtyInkPages.clear();
}

/**
 * Stores recognised ink text for a page (called by the search UI after recognition).
 * Clears the dirty flag for that page.
 *
 * @param {string} pageId
 * @param {string} text
 */
function setPageInkText(pageId, text) {
  _pageInkText[pageId] = text;
  _dirtyInkPages.delete(pageId);
}

/**
 * Returns whether a page's draw strokes have changed since the last recognition run.
 *
 * @param {string} pageId
 * @returns {boolean}
 */
function isPageInkDirty(pageId) {
  return _dirtyInkPages.has(pageId);
}

/**
 * Manually clears the dirty flag for a page (e.g. after recognition is complete).
 *
 * @param {string} pageId
 */
function clearPageInkDirty(pageId) {
  _dirtyInkPages.delete(pageId);
}

function getPageInkSegments() {
  return { ..._pageInkSegments };
}

function loadPageInkSegments(map) {
  _pageInkSegments = (map && typeof map === 'object') ? { ...map } : {};
}

function setPageInkSegments(pageId, segments) {
  _pageInkSegments[pageId] = segments;
}

// ---------------------------------------------------------------------------
// Coordinate shifting (used when pages move due to insert / remove / reorder)
// ---------------------------------------------------------------------------

/**
 * Shifts annotation coordinates for a set of pages by their measured Y delta.
 *
 * pageDeltas is a Map<pageId, dy> where dy is the exact canvas-unit change in
 * that page's canvasY (positive = moved down, negative = moved up).
 *
 * Handles every coordinate format in use:
 *   - points[].y   — freehand draw strokes, highlight strokes, line/rect shapes
 *   - cy           — circle and ellipse shapes (points is [] for these)
 *   - canvasY      — DOM-overlay annotations: sticky notes, tables, images
 *
 * Does not record an undo entry — layout changes are not themselves undoable.
 * Emits 'annotations-changed' so the renderer and autosave pick up the new positions.
 *
 * @param {Map<string, number>} pageDeltas — pageId → signed Y delta in canvas units
 */
function shiftAnnotationsByPageDelta(pageDeltas) {
  if (annotations.length === 0 || pageDeltas.size === 0) return;

  let changed = false;

  for (const anno of annotations) {
    const dy = pageDeltas.get(anno.pageId);
    if (dy === undefined || dy === 0) continue;
    changed = true;

    // Freehand strokes, line/rect snapped shapes — geometry lives in points[]
    if (Array.isArray(anno.points) && anno.points.length > 0) {
      for (const p of anno.points) p.y += dy;
    }

    // Circle / ellipse shapes store centre in cx/cy; points is [] for these
    if (typeof anno.cy === 'number') anno.cy += dy;

    // DOM-overlay annotations (sticky notes, tables, images) use canvasY
    if (typeof anno.canvasY === 'number') anno.canvasY += dy;
  }

  if (changed) emit();
}

export { add, remove, update, batchUpdate, getByPage, getAll, loadFromJSON, toJSON, clear, undo, redo, beginUndoGroup, endUndoGroup, getPageInkText, loadPageInkText, setPageInkText, isPageInkDirty, clearPageInkDirty, getPageInkSegments, loadPageInkSegments, setPageInkSegments, shiftAnnotationsByPageDelta };
