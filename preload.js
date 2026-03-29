/**
 * preload.js — IPC bridge between main process and renderer
 *
 * Security model:
 *   This script runs in a special context that has access to both Node.js
 *   APIs (via ipcRenderer) and the renderer's window object — but they are
 *   isolated from each other by contextIsolation.
 *
 *   contextBridge.exposeInMainWorld() is the ONLY way to pass values from
 *   this script to the renderer. It creates a read-only proxy on window.api
 *   that the renderer can call, but cannot tamper with.
 *
 *   Think of this file as a border control officer: it decides exactly what
 *   the renderer is allowed to request, and enforces it at the boundary.
 *   The renderer never sees Node.js or ipcRenderer — only the clean API below.
 *
 * Exports (as window.api):
 *   openFile()                     → Promise<string|null>
 *   readFile(path)                 → Promise<Uint8Array>
 *   writeFile(path, data)          → Promise<true>
 *   writeBinary(path, data)        → Promise<true>
 *   fileExists(path)               → Promise<boolean>
 *   getFingerprint(path)           → Promise<string>
 *   getAnnotationsPath(pdfPath)    → Promise<string>
 *   savePdfDialog(defaultName)     → Promise<string|null>
 *   loadLibrary()                  → Promise<object|null>
 *   saveLibrary(data)              → Promise<true>
 *   windowControl(action)          → void
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {

  /**
   * Opens the native OS file picker filtered to PDFs.
   * @returns {Promise<string|null>} The chosen file path, or null if cancelled.
   */
  openFile: () =>
    ipcRenderer.invoke('open-file'),

  /**
   * Reads a file from disk.
   * @param {string} filePath - Absolute path to the file.
   * @returns {Promise<Uint8Array>} Raw file bytes.
   */
  readFile: (filePath) =>
    ipcRenderer.invoke('read-file', filePath),

  /**
   * Writes a string to disk.
   * @param {string} filePath - Absolute path to write to.
   * @param {string} data     - String content (UTF-8).
   * @returns {Promise<true>}
   */
  writeFile: (filePath, data) =>
    ipcRenderer.invoke('write-file', filePath, data),

  /**
   * Checks whether a file exists at the given path.
   * Used to detect companion .annotations.json files.
   * @param {string} filePath - Absolute path to check.
   * @returns {Promise<boolean>}
   */
  fileExists: (filePath) =>
    ipcRenderer.invoke('file-exists', filePath),

  /**
   * Returns a SHA-256 fingerprint of the first 8KB of a file.
   * Used to verify annotation files match their source PDF.
   * @param {string} filePath - Absolute path to the PDF.
   * @returns {Promise<string>} Hex digest string.
   */
  getFingerprint: (filePath) =>
    ipcRenderer.invoke('get-fingerprint', filePath),

  /**
   * Captures the entire window as a PNG.
   * Cropping to a region is done client-side to avoid logical/physical pixel
   * coordinate ambiguity on HiDPI screens.
   * @returns {Promise<Uint8Array>} PNG bytes of the full window
   */
  captureScreen: () =>
    ipcRenderer.invoke('capture-screen'),

  /**
   * Loads the persistent file library from userData/library.json.
   * @returns {Promise<object|null>} Parsed library object, or null if not yet created.
   */
  loadLibrary: () =>
    ipcRenderer.invoke('library-load'),

  /**
   * Saves the file library to userData/library.json.
   * @param {object} data — serialisable library object
   * @returns {Promise<true>}
   */
  saveLibrary: (data) =>
    ipcRenderer.invoke('library-save', data),

  /**
   * Opens a native folder-selection dialog.
   * Used by the library panel for "move file" destinations.
   * @returns {Promise<string|null>} Chosen directory path, or null if cancelled.
   */
  openFolderDialog: () =>
    ipcRenderer.invoke('open-folder-dialog'),

  /**
   * Creates a new directory (recursively) at the given path.
   * @param {string} dirPath
   * @returns {Promise<true>}
   */
  createFolder: (dirPath) =>
    ipcRenderer.invoke('create-folder', dirPath),

  /**
   * Moves a file from srcPath to destPath.
   * If destPath is a directory the file is placed inside it.
   * @param {string} srcPath
   * @param {string} destPath
   * @returns {Promise<string>} The final destination path.
   */
  moveFile: (srcPath, destPath) =>
    ipcRenderer.invoke('move-file', srcPath, destPath),

  /**
   * Lists all PDF files in a directory (non-recursive).
   * @param {string} dirPath — Absolute path to the directory to scan
   * @returns {Promise<string[]>} Array of absolute PDF file paths
   */
  scanFolder: (dirPath) =>
    ipcRenderer.invoke('scan-folder', dirPath),

  /**
   * Creates a minimal blank single-page PDF at the given path.
   * Fails if the file already exists.
   * @param {string} filePath — Absolute destination path ending in .pdf
   * @returns {Promise<true>}
   */
  createBlankPdf: (filePath) =>
    ipcRenderer.invoke('create-blank-pdf', filePath),

  /**
   * Permanently deletes a file from disk after a native confirmation dialog.
   * @param {string} filePath — Absolute path of the file to delete
   * @returns {Promise<boolean>} true if deleted, false if user cancelled
   */
  deleteFile: (filePath) =>
    ipcRenderer.invoke('delete-file', filePath),

  /**
   * Returns the path where annotations for a given PDF are stored in userData.
   * Creates the annotations directory if it doesn't exist yet.
   * @param {string} pdfPath — Absolute path to the PDF
   * @returns {Promise<string>} Absolute path to the .json annotations file
   */
  getAnnotationsPath: (pdfPath) =>
    ipcRenderer.invoke('get-annotations-path', pdfPath),

  /**
   * Shows a native Save As dialog filtered to PDF files.
   * Used by the export feature to let the user pick a destination.
   * @param {string} defaultName — Suggested filename
   * @returns {Promise<string|null>} Chosen path, or null if cancelled.
   */
  savePdfDialog: (defaultName) =>
    ipcRenderer.invoke('save-pdf-dialog', defaultName),

  /**
   * Writes raw binary data to disk.
   * Used for writing exported PDF bytes — unlike writeFile() this does not
   * apply UTF-8 encoding, which would corrupt binary data.
   * @param {string}     filePath
   * @param {Uint8Array} data
   * @returns {Promise<true>}
   */
  writeBinary: (filePath, data) =>
    ipcRenderer.invoke('write-binary', filePath, data),

  /**
   * Sends a window control action to the main process.
   * Required because we use a frameless window with custom title bar buttons.
   * @param {'minimise'|'maximise'|'close'} action
   */
  windowControl: (action) =>
    ipcRenderer.send('window-control', action),

  /**
   * Checks GitHub for a newer release.
   * Resolves to { currentVersion, latestVersion, releaseUrl, hasUpdate }.
   * Always resolves (never rejects) — returns hasUpdate: false when offline.
   * @returns {Promise<{currentVersion:string, latestVersion:string|null, releaseUrl:string|null, hasUpdate:boolean}>}
   */
  checkForUpdates: () =>
    ipcRenderer.invoke('check-for-updates'),

  /**
   * Opens a URL in the user's default browser.
   * Only https:// URLs are accepted by the main process.
   * @param {string} url
   */
  openExternal: (url) =>
    ipcRenderer.invoke('open-external', url),

});
