/**
 * library.js — Persistent file library panel
 *
 * Two-section layout:
 *   FOLDERS — pinned directories; click to expand and see PDFs inside (live scan)
 *   RECENT  — individual files opened recently, grouped by directory
 *
 * Storage: userData/library.json via the IPC bridge.
 * Schema v2:
 *   {
 *     version: 2,
 *     folders: [{ path, name, pinnedAt }],
 *     files:   [{ path, name, dir, lastOpened }]
 *   }
 *
 * Migration: v1 data (files only) is loaded as-is with folders:[] added.
 *
 * Exports: initLibrary(openFileFn), addToLibrary(filePath), toggleLibrary()
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIBRARY_VERSION = 2;
const MAX_RECENT      = 50;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {{ version:number, folders:Array<{path,name,pinnedAt}>, files:Array<{path,name,dir,lastOpened}> }} */
let library = { version: LIBRARY_VERSION, folders: [], files: [] };

/** Callback to open a PDF — injected by app.js */
let openFileFn = null;

let panelOpen = false;
let panelEl   = null;
let listEl    = null;

/** Folder paths that are currently expanded in the UI (in-memory, resets on close) */
const expandedFolders = new Set();

/**
 * Subfolder paths that are currently expanded within their parent folder tree.
 * Keyed by the subfolder's absolute path.
 */
const expandedSubfolders = new Set();

/**
 * Live-scan cache: folder path → tree node { files: [{name,path}], subfolders: [{name,path,...}] }
 * Populated when a folder is expanded; cleared when it is collapsed or removed.
 */
const folderFilesCache = new Map();

/**
 * Active filter for the Recent section.
 * 'today' | 'week' | 'all'
 */
let recentFilter = 'all';

/** Set of file paths that no longer exist on disk (for greying out recent entries) */
const missingPaths = new Set();

/** Floating context menu */
let contextMenuEl     = null;
/** { type: 'file'|'folder', data } */
let contextMenuTarget = null;

// ---------------------------------------------------------------------------
// Folder drag-and-drop reorder state
// ---------------------------------------------------------------------------

let _dragFolderIndex  = null;   // index in library.folders being dragged
let _dragHoldTimer    = null;   // long-press timer for touch
let _dragOverIndex    = null;   // index currently hovered over
let _dragEl           = null;   // the row element being dragged

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function initLibrary(openFn) {
  openFileFn = openFn;

  panelEl = document.getElementById('library-panel');
  listEl  = document.getElementById('library-list');

  try {
    const data = await window.api.loadLibrary();
    if (data && Array.isArray(data.files)) {
      library.files   = data.files;
      library.folders = Array.isArray(data.folders) ? data.folders : [];
    }
  } catch (err) {
    console.error('Failed to load library:', err);
  }

  document.getElementById('btn-library')
    ?.addEventListener('click', toggleLibrary);
  document.getElementById('btn-library-close')
    ?.addEventListener('click', closeLibrary);
  document.getElementById('btn-library-open-folder')
    ?.addEventListener('click', handlePinFolder);
  document.getElementById('btn-library-new-folder')
    ?.addEventListener('click', handleNewFolder);

  initFolderInput();

  panelEl.addEventListener('click', (e) => {
    if (e.target === panelEl) closeLibrary();
  });

  buildContextMenu();
  renderList();
  _initBackupUI();
}

// ---------------------------------------------------------------------------
// Backup settings UI
// ---------------------------------------------------------------------------

async function _initBackupUI() {
  const pathEl   = document.getElementById('library-backup-path');
  const chooseBtn = document.getElementById('btn-backup-choose');
  const clearBtn  = document.getElementById('btn-backup-clear');

  async function _refreshBackupUI() {
    const dir = await window.api.getBackupDir();
    if (dir) {
      // Show just the last folder name to keep it compact
      pathEl.textContent   = dir.replace(/\\/g, '/').split('/').pop() || dir;
      pathEl.title         = dir;
      clearBtn.style.display = '';
    } else {
      pathEl.textContent   = 'Not set';
      pathEl.title         = '';
      clearBtn.style.display = 'none';
    }
  }

  await _refreshBackupUI();

  chooseBtn?.addEventListener('click', async () => {
    const dir = await window.api.openFolderDialog();
    if (dir) {
      await window.api.setBackupDir(dir);
      await _refreshBackupUI();
    }
  });

  clearBtn?.addEventListener('click', async () => {
    await window.api.setBackupDir(null);
    await _refreshBackupUI();
  });

  // One-time migration prompt: if the backup folder contains files from the old
  // format (pre-v1.2.3 raw PDF/JSON copies), offer to clean them up.
  _checkLegacyBackupMigration();
}

/**
 * Checks whether the backup folder has non-.vellum files left over from the
 * old backup format. If so, shows a one-time notification bar with two actions:
 * "Clean up" (deletes them) and "Keep" (dismisses forever without deleting).
 */
async function _checkLegacyBackupMigration() {
  const count = await window.api.checkLegacyBackups();
  if (count === 0) return;

  const backupFooter = document.getElementById('library-backup-footer');
  if (!backupFooter) return;

  const bar = document.createElement('div');
  bar.className = 'library-migration-bar';
  bar.innerHTML = `
    <span class="library-migration-msg">Your backup folder has ${count} file${count !== 1 ? 's' : ''} from an older format.</span>
    <div class="library-migration-actions">
      <button class="library-migration-btn library-migration-btn--clean">Clean up</button>
      <button class="library-migration-btn library-migration-btn--keep">Keep</button>
    </div>
  `;

  backupFooter.insertAdjacentElement('beforebegin', bar);

  bar.querySelector('.library-migration-btn--clean').addEventListener('click', async () => {
    await window.api.cleanLegacyBackups();
    bar.remove();
  });

  bar.querySelector('.library-migration-btn--keep').addEventListener('click', async () => {
    await window.api.dismissLegacyBackupPrompt();
    bar.remove();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function addToLibrary(filePath) {
  const name = filePath.replace(/\\/g, '/').split('/').pop();
  const dir  = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '/';

  library.files = library.files.filter(f => f.path !== filePath);
  library.files.unshift({ path: filePath, name, dir, lastOpened: new Date().toISOString() });

  if (library.files.length > MAX_RECENT) {
    library.files = library.files.slice(0, MAX_RECENT);
  }

  renderList();
  await _save();
}

function toggleLibrary() {
  panelOpen ? closeLibrary() : openLibrary();
}

// ---------------------------------------------------------------------------
// Panel open / close
// ---------------------------------------------------------------------------

function openLibrary() {
  panelOpen = true;
  panelEl.classList.add('open');
  document.getElementById('btn-library')?.classList.add('active');
  _checkMissingFiles();
}

function closeLibrary() {
  panelOpen = false;
  panelEl.classList.remove('open');
  document.getElementById('btn-library')?.classList.remove('active');
}

async function _checkMissingFiles() {
  missingPaths.clear();
  await Promise.all(library.files.map(async (file) => {
    const exists = await window.api.fileExists(file.path);
    if (!exists) missingPaths.add(file.path);
  }));
  renderList();
}

// ---------------------------------------------------------------------------
// Pinned folder management
// ---------------------------------------------------------------------------

/**
 * Adds a directory to the pinned folders list and expands it immediately.
 * Does nothing if the folder is already pinned.
 *
 * @param {string} dirPath
 */
async function addPinnedFolder(dirPath) {
  const norm = dirPath.replace(/\\/g, '/').replace(/\/$/, '');
  if (library.folders.some(f => f.path.replace(/\\/g, '/').replace(/\/$/, '') === norm)) return;

  const parts = norm.split('/').filter(Boolean);
  const name  = parts[parts.length - 1] || norm;

  library.folders.push({ path: dirPath, name, pinnedAt: new Date().toISOString() });
  await _save();
  expandedFolders.add(dirPath);
  renderList();
  // Find the placeholder container renderList() just created and populate it
  const container = _findChildrenContainer(dirPath);
  if (container) _expandFolder(dirPath, null, container);
}

/**
 * Removes a directory from the pinned folders list.
 *
 * @param {string} dirPath
 */
async function removePinnedFolder(dirPath) {
  library.folders = library.folders.filter(f => f.path !== dirPath);
  expandedFolders.delete(dirPath);
  folderFilesCache.delete(dirPath);
  renderList();
  await _save();
}

// ---------------------------------------------------------------------------
// Folder expand / collapse
// ---------------------------------------------------------------------------

/**
 * Toggles the expanded state of a folder row.
 * If expanding for the first time, scans the folder and populates the cache.
 *
 * @param {string} dirPath
 * @param {HTMLElement} rowEl — the folder row button
 */
async function toggleFolderExpand(dirPath, rowEl) {
  if (expandedFolders.has(dirPath)) {
    // Collapse — clear this folder and all descendant subfolder states
    expandedFolders.delete(dirPath);
    folderFilesCache.delete(dirPath);
    // Clear any expanded subfolders that were inside this folder
    for (const key of expandedSubfolders) {
      if (key.startsWith(dirPath + '/') || key.startsWith(dirPath + '\\')) {
        expandedSubfolders.delete(key);
      }
    }
    _updateFolderRowArrow(rowEl, false);
    rowEl.nextElementSibling?.remove(); // remove children container
    return;
  }

  // Expand
  expandedFolders.add(dirPath);
  _updateFolderRowArrow(rowEl, true);
  rowEl.classList.add('expanded');

  // Show a loading placeholder
  const placeholder = _makeFolderChildren(dirPath, null);
  rowEl.insertAdjacentElement('afterend', placeholder);

  await _expandFolder(dirPath, rowEl, placeholder);
}

/**
 * Finds the .library-folder-children element for a given dirPath in the DOM.
 * Uses dataset comparison to safely handle paths with special characters.
 */
function _findChildrenContainer(dirPath) {
  if (!listEl) return null;
  for (const el of listEl.querySelectorAll('.library-folder-children')) {
    if (el.dataset.dirPath === dirPath) return el;
  }
  return null;
}

/**
 * Shows an inline name input inside the folder's children container so the
 * user can type a file name and create a blank PDF in that folder.
 * Expands the folder first if it is currently collapsed.
 *
 * @param {string} dirPath
 */
async function _showNewFileInput(dirPath) {
  // Ensure the folder is expanded so we have a children container to attach to
  if (!expandedFolders.has(dirPath)) {
    const folderRow = _findFolderRow(dirPath);
    if (folderRow) await toggleFolderExpand(dirPath, folderRow);
    else return;
  }

  const container = _findChildrenContainer(dirPath);
  if (!container) return;

  // Don't add a second input if one is already open
  if (container.querySelector('.library-newfile-input-row')) return;

  const row = document.createElement('div');
  row.className = 'library-newfile-input-row';

  const input = document.createElement('input');
  input.type          = 'text';
  input.className     = 'library-newfile-input';
  input.placeholder   = 'File name…';
  input.autocomplete  = 'off';
  input.spellcheck    = false;

  const ok = document.createElement('button');
  ok.className   = 'library-folder-input-btn library-folder-input-ok';
  ok.textContent = 'Create';

  const cancel = document.createElement('button');
  cancel.className   = 'library-folder-input-btn';
  cancel.textContent = '✕';

  const dismiss = () => row.remove();

  const commit = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }

    const sep      = dirPath.includes('\\') ? '\\' : '/';
    const filePath = dirPath.replace(/[/\\]+$/, '') + sep + name + '.pdf';

    dismiss();

    try {
      await window.api.createBlankPdf(filePath);
    } catch (err) {
      // Show error briefly in the container
      const errEl = document.createElement('div');
      errEl.className   = 'library-folder-empty';
      errEl.textContent = err.message;
      container.prepend(errEl);
      setTimeout(() => errEl.remove(), 4000);
      return;
    }

    // Refresh folder scan so the new file appears, then add to library and open
    folderFilesCache.delete(dirPath);
    await _expandFolder(dirPath, null, container);
    await addToLibrary(filePath);
    closeLibrary();
    openFileFn?.(filePath);
  };

  ok.addEventListener('click', commit);
  cancel.addEventListener('click', dismiss);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') dismiss();
  });

  row.appendChild(input);
  row.appendChild(ok);
  row.appendChild(cancel);

  // Insert at the top of the children container
  container.prepend(row);
  input.focus();
}

/**
 * Finds the folder row button element for a given dirPath.
 */
function _findFolderRow(dirPath) {
  if (!listEl) return null;
  for (const el of listEl.querySelectorAll('.library-folder-row')) {
    if (el.title === dirPath) return el;
  }
  return null;
}

/**
 * Scans a folder and renders its PDF children.
 * Updates an existing placeholder if provided, otherwise updates the
 * children container that follows rowEl.
 */
async function _expandFolder(dirPath, rowEl, existingContainer) {
  let treeNode = { files: [], subfolders: [] };
  try {
    treeNode = await window.api.scanFolderTree(dirPath);
  } catch (err) {
    console.error('scan-folder-tree error:', err);
  }

  folderFilesCache.set(dirPath, treeNode);

  const container = existingContainer
    ?? (rowEl ? rowEl.nextElementSibling : null);
  if (!container) return;

  _renderFolderTree(treeNode, container, dirPath, 1);
}

/**
 * Renders a folder tree node's contents into a container element.
 * Recursively renders subfolders when they are expanded.
 *
 * @param {{ files: Array<{name,path}>, subfolders: Array<{name,path,...}> }} node
 * @param {HTMLElement} container — element to render into (innerHTML is cleared first)
 * @param {string} parentDirPath  — path of the parent folder (for context menu)
 * @param {number} indentLevel    — nesting depth (1 = direct children of pinned folder)
 */
function _renderFolderTree(node, container, parentDirPath, indentLevel) {
  container.innerHTML = '';
  const indentPx = 20 + (indentLevel - 1) * 16;

  const isEmpty = node.files.length === 0 && node.subfolders.length === 0;
  if (isEmpty) {
    const msg = document.createElement('div');
    msg.className   = 'library-folder-empty';
    msg.style.paddingLeft = `${indentPx}px`;
    msg.textContent = 'No PDFs in this folder';
    container.appendChild(msg);
    return;
  }

  // Render PDFs in this directory
  for (const file of node.files) {
    const row = document.createElement('button');
    row.className         = 'library-file library-folder-file';
    row.title             = file.path;
    row.style.paddingLeft = `${indentPx}px`;

    const nameEl = document.createElement('span');
    nameEl.className   = 'library-file-name';
    nameEl.textContent = file.name;

    row.appendChild(nameEl);
    row.addEventListener('click', () => {
      closeLibrary();
      openFileFn?.(file.path);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, 'folder-file', { filePath: file.path, dirPath: parentDirPath });
    });

    container.appendChild(row);
  }

  // Render subfolders
  for (const sub of node.subfolders) {
    const isExpanded = expandedSubfolders.has(sub.path);
    const subIndentPx = indentPx;

    const subRow = document.createElement('button');
    subRow.className         = 'library-subfolder-row' + (isExpanded ? ' expanded' : '');
    subRow.title             = sub.path;
    subRow.style.paddingLeft = `${subIndentPx}px`;

    const arrow = document.createElement('span');
    arrow.className   = 'library-folder-arrow';
    arrow.textContent = isExpanded ? '▾' : '▸';

    const icon = document.createElement('span');
    icon.className   = 'library-folder-icon';
    icon.textContent = '⌂';

    const nameEl = document.createElement('span');
    nameEl.className   = 'library-folder-name';
    nameEl.textContent = sub.name;

    subRow.appendChild(arrow);
    subRow.appendChild(icon);
    subRow.appendChild(nameEl);
    container.appendChild(subRow);

    // Subfolder children container (only present when expanded)
    if (isExpanded) {
      const subContainer = document.createElement('div');
      subContainer.className = 'library-folder-children';
      container.appendChild(subContainer);
      _renderFolderTree(sub, subContainer, sub.path, indentLevel + 1);
    }

    subRow.addEventListener('click', () => {
      if (expandedSubfolders.has(sub.path)) {
        expandedSubfolders.delete(sub.path);
      } else {
        expandedSubfolders.add(sub.path);
      }
      // Re-render the parent folder's children container
      const parentContainer = subRow.closest('.library-folder-children');
      if (parentContainer) _renderFolderTree(node, parentContainer, parentDirPath, indentLevel);
    });
  }
}

/**
 * Creates a folder children container element.
 * If paths is null, shows a loading state.
 */
function _makeFolderChildren(dirPath, paths) {
  const container = document.createElement('div');
  container.className       = 'library-folder-children';
  container.dataset.dirPath = dirPath;

  if (paths === null) {
    const msg = document.createElement('div');
    msg.className   = 'library-folder-empty';
    msg.textContent = 'Scanning…';
    container.appendChild(msg);
  }

  return container;
}

function _updateFolderRowArrow(rowEl, expanded) {
  const arrow = rowEl?.querySelector('.library-folder-arrow');
  if (arrow) arrow.textContent = expanded ? '▾' : '▸';
  rowEl?.classList.toggle('expanded', expanded);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * "Open Folder" button — picks a directory and pins it permanently.
 */
async function handlePinFolder() {
  const dir = await window.api.openFolderDialog();
  if (!dir) return;
  await addPinnedFolder(dir);
}

/**
 * "New Folder" button — shows the inline name input.
 */
function handleNewFolder() {
  showFolderInput();
}

/**
 * Removes a file entry from the recent list and persists.
 */
async function removeFromRecent(filePath) {
  library.files = library.files.filter(f => f.path !== filePath);
  renderList();
  await _save();
}

/**
 * Renames a file on disk then updates the library entry and folder cache.
 * @param {string} filePath — Absolute path of the PDF to rename
 * @param {string} [dirPath] — Containing folder path, for refreshing folder view
 */
async function handleRenameFile(filePath, dirPath) {
  const currentName = filePath.replace(/\\/g, '/').split('/').pop().replace(/\.pdf$/i, '');
  const newName = window.prompt('Rename file:', currentName);
  if (!newName || newName.trim() === '' || newName.trim() === currentName) return;

  try {
    const newPath = await window.api.renameFile(filePath, newName.trim());

    // Update recent files entry if present
    const entry = library.files.find(f => f.path === filePath);
    if (entry) {
      const parts = newPath.replace(/\\/g, '/').split('/');
      entry.path = newPath;
      entry.name = parts[parts.length - 1];
      entry.dir  = parts.slice(0, -1).join('/') || '/';
    }

    // Refresh the folder scan if this file lives in a pinned folder
    if (dirPath) {
      folderFilesCache.delete(dirPath);
      const container = _findChildrenContainer(dirPath);
      if (container) await _expandFolder(dirPath, null, container);
    }

    renderList();
    await _save();
  } catch (err) {
    alert(`Could not rename: ${err.message}`);
  }
}

/**
 * Moves a file then updates its library entry.
 */
async function handleMoveFile(file) {
  const destDir = await window.api.openFolderDialog();
  if (!destDir) return;

  try {
    const newPath = await window.api.moveFile(file.path, destDir);
    const entry = library.files.find(f => f.path === file.path);
    if (entry) {
      const parts  = newPath.replace(/\\/g, '/').split('/');
      entry.path   = newPath;
      entry.name   = parts[parts.length - 1];
      entry.dir    = parts.slice(0, -1).join('/') || '/';
      renderList();
      await _save();
    }
  } catch (err) {
    console.error('move-file error:', err);
  }
}

// ---------------------------------------------------------------------------
// Inline new-folder input
// ---------------------------------------------------------------------------

let folderInputRowEl = null;
let folderInputEl    = null;

function initFolderInput() {
  folderInputRowEl = document.getElementById('library-folder-input-row');
  folderInputEl    = document.getElementById('library-folder-input');

  document.getElementById('library-folder-input-ok')
    ?.addEventListener('click', commitNewFolder);
  document.getElementById('library-folder-input-cancel')
    ?.addEventListener('click', hideFolderInput);

  folderInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commitNewFolder(); }
    if (e.key === 'Escape') hideFolderInput();
  });
}

function showFolderInput() {
  folderInputRowEl?.classList.remove('hidden');
  if (folderInputEl) folderInputEl.value = '';
  folderInputEl?.focus();
}

function hideFolderInput() {
  folderInputRowEl?.classList.add('hidden');
}

async function commitNewFolder() {
  const name = folderInputEl?.value.trim();
  if (!name) { folderInputEl?.focus(); return; }

  hideFolderInput();

  const parentDir = await window.api.openFolderDialog();
  if (!parentDir) return;

  const sep      = parentDir.includes('\\') ? '\\' : '/';
  const fullPath = parentDir.replace(/[/\\]+$/, '') + sep + name;

  try {
    await window.api.createFolder(fullPath);
  } catch (err) {
    const errRow = document.createElement('p');
    errRow.className   = 'library-empty';
    errRow.textContent = `Could not create folder: ${err.message}`;
    listEl?.prepend(errRow);
    setTimeout(() => errRow.remove(), 4000);
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function buildContextMenu() {
  contextMenuEl = document.createElement('div');
  contextMenuEl.className = 'library-context-menu hidden';
  document.body.appendChild(contextMenuEl);

  document.addEventListener('pointerdown', (e) => {
    if (!contextMenuEl.contains(e.target)) hideContextMenu();
  }, { capture: true });
}

function showContextMenu(e, type, data) {
  contextMenuTarget = { type, data };
  contextMenuEl.innerHTML = '';

  if (type === 'folder') {
    _addMenuItem('Remove from library', () => {
      const d = contextMenuTarget?.data;
      hideContextMenu();
      if (d) removePinnedFolder(d.path);
    });
  } else if (type === 'folder-file') {
    _addMenuItem('Rename…', async () => {
      const d = contextMenuTarget?.data;
      hideContextMenu();
      if (d) await handleRenameFile(d.filePath, d.dirPath);
    });
    _addMenuItem('Delete file…', async () => {
      const d = contextMenuTarget?.data;
      hideContextMenu();
      if (!d) return;
      const deleted = await window.api.deleteFile(d.filePath);
      if (!deleted) return;
      // Remove from recent list if present
      library.files = library.files.filter(f => f.path !== d.filePath);
      // Refresh the folder scan so the file disappears from the expanded view
      folderFilesCache.delete(d.dirPath);
      const container = _findChildrenContainer(d.dirPath);
      if (container) await _expandFolder(d.dirPath, null, container);
      await _save();
    });
  } else {
    _addMenuItem('Rename…', async () => {
      const d = contextMenuTarget?.data;
      hideContextMenu();
      if (d) await handleRenameFile(d.path, null);
    });
    _addMenuItem('Move to folder…', async () => {
      const d = contextMenuTarget?.data;
      hideContextMenu();
      if (d) await handleMoveFile(d);
    });
    _addMenuItem('Remove from recent', () => {
      const d = contextMenuTarget?.data;
      hideContextMenu();
      if (d) removeFromRecent(d.path);
    });
  }

  contextMenuEl.classList.remove('hidden');
  const x = Math.min(e.clientX, window.innerWidth  - contextMenuEl.offsetWidth  - 8);
  const y = Math.min(e.clientY, window.innerHeight - contextMenuEl.offsetHeight - 8);
  contextMenuEl.style.left = `${Math.max(0, x)}px`;
  contextMenuEl.style.top  = `${Math.max(0, y)}px`;
}

function _addMenuItem(label, handler) {
  const btn = document.createElement('button');
  btn.className   = 'library-context-item';
  btn.textContent = label;
  btn.addEventListener('click', handler);
  contextMenuEl.appendChild(btn);
}

function hideContextMenu() {
  contextMenuEl?.classList.add('hidden');
  contextMenuTarget = null;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderList() {
  if (!listEl) return;
  listEl.innerHTML = '';

  const hasFolders = library.folders.length > 0;
  const hasFiles   = library.files.length   > 0;

  if (!hasFolders && !hasFiles) {
    const empty = document.createElement('p');
    empty.className   = 'library-empty';
    empty.textContent = 'Nothing here yet.\nUse Open to load a PDF, or pin a folder.';
    listEl.appendChild(empty);
    return;
  }

  if (hasFolders) _renderFolderSection();
  if (hasFiles)   _renderRecentSection();
}

/**
 * Attaches pointer-event drag-and-drop reorder logic to a drag handle element.
 * Mouse: immediate drag on pointerdown.
 * Touch: 500ms long-press to activate drag, movement before that cancels.
 */
function _attachDragHandle(handleEl, rowEl, index) {
  handleEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation();

    if (e.pointerType === 'touch') {
      // Touch: wait for long-press before starting drag
      _dragHoldTimer = setTimeout(() => {
        _startFolderDrag(e, rowEl, index);
      }, 500);

      // Cancel long-press if finger moves significantly before timer fires
      const cancelThreshold = 8;
      const startX = e.clientX, startY = e.clientY;
      const onEarlyMove = (mv) => {
        if (Math.abs(mv.clientX - startX) > cancelThreshold ||
            Math.abs(mv.clientY - startY) > cancelThreshold) {
          clearTimeout(_dragHoldTimer);
          _dragHoldTimer = null;
          document.removeEventListener('pointermove', onEarlyMove);
        }
      };
      document.addEventListener('pointermove', onEarlyMove, { passive: true });
      setTimeout(() => document.removeEventListener('pointermove', onEarlyMove), 600);
    } else {
      // Mouse/pen: start drag immediately
      _startFolderDrag(e, rowEl, index);
    }
  });
}

function _startFolderDrag(e, rowEl, index) {
  _dragFolderIndex = index;
  _dragEl = rowEl;
  rowEl.classList.add('library-folder-dragging');

  const onMove = (mv) => {
    if (_dragFolderIndex === null) return;
    // Find which folder row the pointer is over
    const els = listEl.querySelectorAll('.library-folder-row:not(.library-folder-dragging)');
    let targetIndex = null;
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (mv.clientY >= rect.top && mv.clientY <= rect.bottom) {
        targetIndex = parseInt(el.dataset.folderIndex, 10);
        break;
      }
    }
    // Update drop indicator
    listEl.querySelectorAll('.library-folder-row').forEach(el => {
      el.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    if (targetIndex !== null && targetIndex !== _dragFolderIndex) {
      const targetEl = listEl.querySelector(`.library-folder-row[data-folder-index="${targetIndex}"]`);
      if (targetEl) {
        const rect = targetEl.getBoundingClientRect();
        const insertBefore = mv.clientY < rect.top + rect.height / 2;
        targetEl.classList.add(insertBefore ? 'drag-over-top' : 'drag-over-bottom');
        _dragOverIndex = insertBefore ? targetIndex : targetIndex + 1;
      }
    } else {
      _dragOverIndex = null;
    }
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup',   onUp);
    listEl.querySelectorAll('.library-folder-row').forEach(el => {
      el.classList.remove('drag-over-top', 'drag-over-bottom', 'library-folder-dragging');
    });
    if (_dragOverIndex !== null && _dragFolderIndex !== null &&
        _dragOverIndex !== _dragFolderIndex && _dragOverIndex !== _dragFolderIndex + 1) {
      // Move folder in array
      const [moved] = library.folders.splice(_dragFolderIndex, 1);
      const insertAt = _dragOverIndex > _dragFolderIndex ? _dragOverIndex - 1 : _dragOverIndex;
      library.folders.splice(insertAt, 0, moved);
      _save();
      renderList();
    }
    _dragFolderIndex = null;
    _dragOverIndex   = null;
    _dragEl          = null;
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup',   onUp);
}

function _renderFolderSection() {
  const header = _makeSectionHeader('Folders');
  listEl.appendChild(header);

  for (let fi = 0; fi < library.folders.length; fi++) {
    const folder     = library.folders[fi];
    const isExpanded = expandedFolders.has(folder.path);
    const folderIndex = fi; // capture for closure

    // Folder row
    const row = document.createElement('button');
    row.className       = 'library-folder-row' + (isExpanded ? ' expanded' : '');
    row.title           = folder.path;
    row.dataset.folderIndex = folderIndex;

    // Drag handle — initiates reorder; touch needs long-press
    const dragHandle = document.createElement('span');
    dragHandle.className   = 'library-folder-drag-handle';
    dragHandle.textContent = '⠿';
    dragHandle.title       = 'Drag to reorder';
    _attachDragHandle(dragHandle, row, folderIndex);

    const icon = document.createElement('span');
    icon.className   = 'library-folder-icon';
    icon.textContent = '⌂'; // replaced by CSS with a folder SVG via background

    const nameEl = document.createElement('span');
    nameEl.className   = 'library-folder-name';
    nameEl.textContent = folder.name;

    const arrow = document.createElement('span');
    arrow.className   = 'library-folder-arrow';
    arrow.textContent = isExpanded ? '▾' : '▸';

    row.appendChild(dragHandle);
    row.appendChild(icon);
    row.appendChild(nameEl);

    // "New file" button — visible on hover, creates a blank PDF in this folder
    const newFileBtn = document.createElement('button');
    newFileBtn.className   = 'library-folder-newfile';
    newFileBtn.title       = 'New file in this folder';
    newFileBtn.textContent = '+';
    newFileBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger expand/collapse
      _showNewFileInput(folder.path);
    });
    row.appendChild(newFileBtn);

    row.appendChild(arrow);

    row.addEventListener('click', () => toggleFolderExpand(folder.path, row));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, 'folder', folder);
    });

    listEl.appendChild(row);

    // If this folder is expanded, render its children immediately from cache
    if (isExpanded) {
      const cached = folderFilesCache.get(folder.path) ?? null;
      const container = _makeFolderChildren(folder.path, cached);

      if (cached !== null) {
        // Rebuild tree from cache synchronously
        _renderFolderTree(cached, container, folder.path, 1);
      }

      listEl.appendChild(container);
    }
  }
}

function _renderRecentSection() {
  const header = _makeSectionHeader('Recent');
  listEl.appendChild(header);

  // Filter pills — Today / Last 7 days / All
  const pillRow = document.createElement('div');
  pillRow.className = 'library-filter-row';
  for (const { label, value } of [
    { label: 'Today', value: 'today' },
    { label: '7 days', value: 'week' },
    { label: 'All', value: 'all' },
  ]) {
    const pill = document.createElement('button');
    pill.className   = 'library-filter-pill' + (recentFilter === value ? ' active' : '');
    pill.textContent = label;
    pill.addEventListener('click', () => {
      recentFilter = value;
      renderList();
    });
    pillRow.appendChild(pill);
  }
  listEl.appendChild(pillRow);

  // Apply filter to files
  const now = Date.now();
  const cutoff = recentFilter === 'today' ? 86400000 : recentFilter === 'week' ? 604800000 : Infinity;
  const visibleFiles = library.files.filter(f => {
    if (cutoff === Infinity) return true;
    try { return (now - new Date(f.lastOpened).getTime()) <= cutoff; } catch { return false; }
  });

  // Group by directory
  const groups = new Map();
  for (const file of visibleFiles) {
    if (!groups.has(file.dir)) groups.set(file.dir, []);
    groups.get(file.dir).push(file);
  }

  if (visibleFiles.length === 0) {
    const empty = document.createElement('p');
    empty.className   = 'library-empty';
    empty.textContent = recentFilter === 'today' ? 'No files opened today.'
      : recentFilter === 'week' ? 'No files opened in the last 7 days.'
      : 'No recent files.';
    listEl.appendChild(empty);
    return;
  }

  for (const [dir, files] of groups) {
    const heading = document.createElement('div');
    heading.className   = 'library-dir';
    heading.textContent = _formatDir(dir);
    heading.title       = dir;
    listEl.appendChild(heading);

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
      dateEl.textContent = isMissing ? 'not found' : _formatDate(file.lastOpened);

      row.appendChild(nameEl);
      row.appendChild(dateEl);

      row.addEventListener('click', () => {
        if (isMissing) return;
        closeLibrary();
        openFileFn?.(file.path);
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e, 'file', file);
      });

      listEl.appendChild(row);
    }
  }
}

function _makeSectionHeader(label) {
  const el = document.createElement('div');
  el.className   = 'library-section-header';
  el.textContent = label;
  return el;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function _save() {
  try {
    await window.api.saveLibrary(library);
  } catch (err) {
    console.error('Failed to save library:', err);
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function _formatDir(dir) {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  if (parts.length <= 2) return parts.join('/');
  return '…/' + parts.slice(-2).join('/');
}

function _formatDate(iso) {
  try {
    const d       = new Date(iso);
    const diffMs  = Date.now() - d;
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7)   return `${diffDays}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { initLibrary, addToLibrary, toggleLibrary };
