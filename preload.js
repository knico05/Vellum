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
 *   fileExists(path)               → Promise<boolean>
 *   getFingerprint(path)           → Promise<string>
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
   * Sends a window control action to the main process.
   * Required because we use a frameless window with custom title bar buttons.
   * @param {'minimise'|'maximise'|'close'} action
   */
  windowControl: (action) =>
    ipcRenderer.send('window-control', action),

});
