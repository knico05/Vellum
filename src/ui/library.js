/**
 * library.js — Persistent file library panel
 *
 * A slide-in drawer that shows recently opened PDFs, grouped by directory.
 * Clicking a file entry opens it. Right-clicking shows a context menu with
 * "Move to folder" and "Remove from library" options.
 * The header has a "New Folder" button that creates a directory on disk.
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

/** Floating context menu element */
let contextMenuEl = null;

/** File currently targeted by the context menu */
let contextMenuFile = null;

/**
 * Set of file paths that no longer exist on disk.
 * Populated by checkMissingFiles() each time the panel opens.
 * Used by renderList() to grey out stale entries.
 */
const missingPaths = new Set();

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

  // New Folder button
  document.getElementById('btn-library-new-folder')?.addEventListener('click', handleNewFolder);

  // Close when clicking outside the inner panel (backdrop area)
  panelEl.addEventListener('click', (e) => {
    if (e.target === panelEl) closeLibrary();
  });

  buildContextMenu();
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
  // Check for stale paths each time the panel opens so the list reflects
  // files that were renamed or deleted outside the app since last open.
  checkMissingFiles();
}

/**
 * Checks whether each library entry still exists on disk.
 * Updates missingPaths and re-renders the list.
 * Runs asynchronously so it doesn't block the panel opening.
 */
async function checkMissingFiles() {
  missingPaths.clear();
  await Promise.all(library.files.map(async (file) => {
    const exists = await window.api.fileExists(file.path);
    if (!exists) missingPaths.add(file.path);
  }));
  renderList();
}

function closeLibrary() {
  panelOpen = false;
  panelEl.classList.remove('open');
  document.getElementById('btn-library')?.classList.remove('active');
}

// ---------------------------------------------------------------------------
// Folder management
// ---------------------------------------------------------------------------

/**
 * Handles "New Folder" — opens a folder dialog to pick a parent directory,
 * then prompts for a folder name and creates it on disk.
 */
async function handleNewFolder() {
  const parentDir = await window.api.openFolderDialog();
  if (!parentDir) return;

  const folderName = prompt('Folder name:');
  if (!folderName || !folderName.trim()) return;

  const fullPath = parentDir.replace(/\\/g, '/') + '/' + folderName.trim();
  try {
    await window.api.createFolder(fullPath);
    alert(`Folder created:\n${fullPath}`);
  } catch (err) {
    alert(`Failed to create folder:\n${err.message}`);
  }
}

/**
 * Handles "Move to folder" context menu action — shows a folder picker and
 * moves the file, then updates the library entry to reflect the new path.
 *
 * @param {{ path: string, name: string }} file
 */
async function handleMoveFile(file) {
  const destDir = await window.api.openFolderDialog();
  if (!destDir) return;

  try {
    const newPath = await window.api.moveFile(file.path, destDir);

    // Update the library entry to point to the new location
    const entry = library.files.find(f => f.path === file.path);
    if (entry) {
      const parts = newPath.replace(/\\/g, '/').split('/');
      entry.path = newPath;
      entry.name = parts[parts.length - 1];
      entry.dir  = parts.slice(0, -1).join('/') || '/';
      renderList();
      await window.api.saveLibrary(library);
    }
  } catch (err) {
    alert(`Failed to move file:\n${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

/**
 * Builds the floating context menu element and appends it to the body.
 * The menu is hidden until showContextMenu() positions and reveals it.
 */
function buildContextMenu() {
  contextMenuEl = document.createElement('div');
  contextMenuEl.className = 'library-context-menu hidden';

  const moveItem = document.createElement('button');
  moveItem.className   = 'library-context-item';
  moveItem.textContent = 'Move to folder…';
  moveItem.addEventListener('click', async () => {
    // Capture before hideContextMenu() clears contextMenuFile
    const file = contextMenuFile;
    hideContextMenu();
    if (file) await handleMoveFile(file);
  });

  const removeItem = document.createElement('button');
  removeItem.className   = 'library-context-item';
  removeItem.textContent = 'Remove from library';
  removeItem.addEventListener('click', () => {
    // Capture before hideContextMenu() clears contextMenuFile
    const file = contextMenuFile;
    hideContextMenu();
    if (file) removeFromLibrary(file.path);
  });

  contextMenuEl.appendChild(moveItem);
  contextMenuEl.appendChild(removeItem);
  document.body.appendChild(contextMenuEl);

  // Dismiss on click anywhere outside
  document.addEventListener('pointerdown', (e) => {
    if (!contextMenuEl.contains(e.target)) hideContextMenu();
  }, { capture: true });
}

function showContextMenu(e, file) {
  contextMenuFile = file;
  // Make visible first so offsetWidth/Height are measurable, then clamp
  contextMenuEl.classList.remove('hidden');
  const x = Math.min(e.clientX, window.innerWidth  - contextMenuEl.offsetWidth  - 8);
  const y = Math.min(e.clientY, window.innerHeight - contextMenuEl.offsetHeight - 8);
  contextMenuEl.style.left = `${Math.max(0, x)}px`;
  contextMenuEl.style.top  = `${Math.max(0, y)}px`;
}

function hideContextMenu() {
  contextMenuEl?.classList.add('hidden');
  contextMenuFile = null;
}

/**
 * Removes a file entry from the in-memory library and persists the change.
 * Does NOT delete the file from disk.
 *
 * @param {string} filePath
 */
async function removeFromLibrary(filePath) {
  library.files = library.files.filter(f => f.path !== filePath);
  renderList();
  try {
    await window.api.saveLibrary(library);
  } catch (err) {
    console.error('Failed to save library after remove:', err);
  }
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
      const isMissing = missingPaths.has(file.path);

      const row = document.createElement('button');
      row.className = 'library-file' + (isMissing ? ' library-file-missing' : '');
      row.title     = isMissing ? `${file.path}\n(file not found)` : file.path;

      const nameEl = document.createElement('span');
      nameEl.className   = 'library-file-name';
      nameEl.textContent = file.name;

      const dateEl = document.createElement('span');
      dateEl.className   = 'library-file-date';
      dateEl.textContent = isMissing ? 'not found' : formatDate(file.lastOpened);

      row.appendChild(nameEl);
      row.appendChild(dateEl);

      row.addEventListener('click', () => {
        if (isMissing) return; // Don't try to open a file that doesn't exist
        closeLibrary();
        openFileFn?.(file.path);
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e, file);
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
