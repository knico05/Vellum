/**
 * library.js — Persistent file library panel
 *
 * A slide-in drawer that shows recently opened PDFs, grouped by directory.
 * Clicking a file entry triggers the provided openFile callback.
 *
 * Storage: userData/library.json via the IPC bridge.
 * Schema:
 *   { version: 1, files: [{ path, name, dir, lastOpened }] }
 *
 * Files are stored most-recent-first. Max 50 entries.
 *
 * Exports: initLibrary(openFileFn), addToLibrary(filePath), toggleLibrary()
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIBRARY_VERSION  = 1;
const MAX_ENTRIES      = 50;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {{ version: number, files: Array<{path,name,dir,lastOpened}> }} */
let library = { version: LIBRARY_VERSION, files: [] };

/** Callback to open a PDF — injected by app.js */
let openFileFn = null;

/** Whether the panel is currently open */
let panelOpen = false;

/** The #library-panel DOM element */
let panelEl = null;

/** The #library-list DOM element (inner scroll container) */
let listEl = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initialises the library panel.
 * Loads persisted data, builds the DOM, and wires up the toggle button.
 *
 * @param {function(string): void} openFn — called with a file path when the
 *   user clicks a library entry
 */
async function initLibrary(openFn) {
  openFileFn = openFn;

  panelEl = document.getElementById('library-panel');
  listEl  = document.getElementById('library-list');

  // Load persisted library from disk
  try {
    const data = await window.api.loadLibrary();
    if (data && data.version === LIBRARY_VERSION && Array.isArray(data.files)) {
      library = data;
    }
  } catch (err) {
    console.error('Failed to load library:', err);
  }

  // Toggle button in the toolbar
  const btn = document.getElementById('btn-library');
  if (btn) btn.addEventListener('click', toggleLibrary);

  // Close button inside the panel
  document.getElementById('btn-library-close')?.addEventListener('click', closeLibrary);

  // Close when clicking outside the inner panel (backdrop area)
  panelEl.addEventListener('click', (e) => {
    if (e.target === panelEl) closeLibrary();
  });

  renderList();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Adds a file path to the library (or moves it to the top if already present).
 * Persists immediately.
 *
 * @param {string} filePath — Absolute path of the opened PDF
 */
async function addToLibrary(filePath) {
  const name = filePath.replace(/\\/g, '/').split('/').pop();
  const dir  = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '/';

  // Remove existing entry for this path, then prepend a fresh one
  library.files = library.files.filter(f => f.path !== filePath);
  library.files.unshift({ path: filePath, name, dir, lastOpened: new Date().toISOString() });

  // Enforce max size
  if (library.files.length > MAX_ENTRIES) {
    library.files = library.files.slice(0, MAX_ENTRIES);
  }

  renderList();

  try {
    await window.api.saveLibrary(library);
  } catch (err) {
    console.error('Failed to save library:', err);
  }
}

/**
 * Opens or closes the library panel.
 */
function toggleLibrary() {
  panelOpen ? closeLibrary() : openLibrary();
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function openLibrary() {
  panelOpen = true;
  panelEl.classList.add('open');
  document.getElementById('btn-library')?.classList.add('active');
}

function closeLibrary() {
  panelOpen = false;
  panelEl.classList.remove('open');
  document.getElementById('btn-library')?.classList.remove('active');
}

/**
 * Rebuilds the list DOM from the current library state.
 * Groups files by directory.
 */
function renderList() {
  if (!listEl) return;
  listEl.innerHTML = '';

  if (library.files.length === 0) {
    const empty = document.createElement('p');
    empty.className   = 'library-empty';
    empty.textContent = 'No files opened yet.\nUse Open to load a PDF.';
    listEl.appendChild(empty);
    return;
  }

  // Group by directory, preserving recency order within each group
  /** @type {Map<string, Array>} */
  const groups = new Map();
  for (const file of library.files) {
    if (!groups.has(file.dir)) groups.set(file.dir, []);
    groups.get(file.dir).push(file);
  }

  for (const [dir, files] of groups) {
    // Directory heading
    const heading = document.createElement('div');
    heading.className   = 'library-dir';
    heading.textContent = formatDir(dir);
    heading.title       = dir;
    listEl.appendChild(heading);

    // File entries
    for (const file of files) {
      const row = document.createElement('button');
      row.className   = 'library-file';
      row.title       = file.path;

      const nameEl = document.createElement('span');
      nameEl.className   = 'library-file-name';
      nameEl.textContent = file.name;

      const dateEl = document.createElement('span');
      dateEl.className   = 'library-file-date';
      dateEl.textContent = formatDate(file.lastOpened);

      row.appendChild(nameEl);
      row.appendChild(dateEl);

      row.addEventListener('click', () => {
        closeLibrary();
        openFileFn?.(file.path);
      });

      listEl.appendChild(row);
    }
  }
}

/**
 * Shortens a directory path for display.
 * Shows only the last two path segments to keep it readable.
 *
 * @param {string} dir
 * @returns {string}
 */
function formatDir(dir) {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  if (parts.length <= 2) return parts.join('/');
  return '…/' + parts.slice(-2).join('/');
}

/**
 * Formats an ISO timestamp as a short relative or absolute date.
 *
 * @param {string} iso
 * @returns {string}
 */
function formatDate(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7)  return `${diffDays}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { initLibrary, addToLibrary, toggleLibrary };
