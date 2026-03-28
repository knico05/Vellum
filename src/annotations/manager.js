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
 *          loadFromJSON(), toJSON(), clear(), undo(), redo()
 */

'use strict';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Master array of all annotation objects for the current document */
let annotations = [];

// ---------------------------------------------------------------------------
// Undo stack
// ---------------------------------------------------------------------------

/**
 * Stack of reversible actions. Each entry is one of:
 *   { action: 'add',    id, annotation }          — undo removes; redo re-adds
 *   { action: 'remove', annotation }              — undo re-inserts; redo removes
 *   { action: 'move',   undo: patches, redo: patches } — undo/redo apply position patches
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

  // Record for undo — store full annotation so redo can re-insert it exactly.
  // New user action clears redo history.
  undoStack.push({ action: 'add', id: annotation.id, annotation });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];

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
  // New user action clears redo history.
  undoStack.push({ action: 'remove', annotation: { ...target } });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];

  annotations = annotations.filter(a => a.id !== id);
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

  annotations[idx] = {
    ...annotations[idx],
    ...changes,
    id:        annotations[idx].id,   // ID is immutable
    createdAt: annotations[idx].createdAt, // createdAt is immutable
    updatedAt: new Date().toISOString(),
  };
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
  emit();
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
  annotations = [];
  undoStack   = [];
  redoStack   = [];
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

export { add, remove, update, batchUpdate, getByPage, getAll, loadFromJSON, toJSON, clear, undo, redo };
