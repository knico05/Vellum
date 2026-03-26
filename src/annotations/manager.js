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
 * Exports: add(), remove(), update(), getByPage(), getAll(),
 *          loadFromJSON(), toJSON(), clear(), undo()
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
 *   { action: 'add',    id: string }                  — undo removes the annotation
 *   { action: 'remove', annotation: object }           — undo re-inserts the annotation
 *
 * Maximum 50 entries. When full, the oldest entry is dropped.
 */
const MAX_UNDO = 50;
let undoStack = [];

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

  // Record for undo — push add entry, cap at MAX_UNDO
  undoStack.push({ action: 'add', id: annotation.id });
  if (undoStack.length > MAX_UNDO) undoStack.shift();

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

  // Record for undo BEFORE removing, so we can restore the full object
  undoStack.push({ action: 'remove', annotation: { ...target } });
  if (undoStack.length > MAX_UNDO) undoStack.shift();

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
 * @param {number} pageIndex — 0-based page index
 * @returns {object[]}
 */
function getByPage(pageIndex) {
  return annotations.filter(a => a.pageIndex === pageIndex);
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
  if (hadContent) emit();
}

/**
 * Reverses the most recent add or remove action.
 *
 * - Undoing an 'add' removes the annotation by ID.
 * - Undoing a 'remove' re-inserts the annotation object exactly.
 *   The re-insert does NOT push to undoStack (it is a restoration, not a new action).
 *
 * No-ops silently if the stack is empty.
 */
function undo() {
  if (undoStack.length === 0) return;

  const entry = undoStack.pop();

  if (entry.action === 'add') {
    // Remove without pushing a new undo entry
    annotations = annotations.filter(a => a.id !== entry.id);
    emit();
  } else if (entry.action === 'remove') {
    // Re-insert the annotation directly without calling add() to avoid
    // pushing a duplicate undo entry
    annotations.push(entry.annotation);
    emit();
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Applies multiple position updates in one operation, emitting a single
 * 'annotations-changed' event. Used by the select tool to commit a drag move.
 * Does NOT push to the undo stack (move undo is not yet supported).
 *
 * @param {Array<{id: string, changes: object}>} updates
 */
function batchUpdate(updates) {
  const now = new Date().toISOString();
  for (const { id, changes } of updates) {
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
  emit();
}

export { add, remove, update, batchUpdate, getByPage, getAll, loadFromJSON, toJSON, clear, undo };
