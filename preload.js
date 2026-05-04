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
   * Shows a native Save As dialog filtered to .vellum files.
   * @param {string} defaultName — Suggested filename
   * @returns {Promise<string|null>} Chosen path, or null if cancelled
   */
  saveVellumDialog: (defaultName) =>
    ipcRenderer.invoke('save-vellum-dialog', defaultName),

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
   * Returns the currently configured auto-backup folder path, or null.
   * @returns {Promise<string|null>}
   */
  getBackupDir: () =>
    ipcRenderer.invoke('get-backup-dir'),

  /**
   * Returns the count of non-.vellum files in the backup folder.
   * Returns 0 if no backup folder is set or migration was already done.
   * @returns {Promise<number>}
   */
  checkLegacyBackups: () =>
    ipcRenderer.invoke('check-legacy-backups'),

  /**
   * Deletes all non-.vellum files from the backup folder and marks migration done.
   * @returns {Promise<true>}
   */
  cleanLegacyBackups: () =>
    ipcRenderer.invoke('clean-legacy-backups'),

  /**
   * Records that the user chose to keep old backup files. Hides the prompt permanently.
   * @returns {Promise<true>}
   */
  dismissLegacyBackupPrompt: () =>
    ipcRenderer.invoke('dismiss-legacy-backup-prompt'),

  /**
   * Sets (or clears) the auto-backup folder. Pass null to disable.
   * @param {string|null} dirPath
   * @returns {Promise<true>}
   */
  setBackupDir: (dirPath) =>
    ipcRenderer.invoke('set-backup-dir', dirPath),

  /**
   * Copies a file into a destination directory.
   * Used by auto-backup to copy the annotation JSON and PDF to the backup folder.
   * @param {string} srcPath  — absolute source file path
   * @param {string} destDir  — absolute destination directory
   * @returns {Promise<true>}
   */
  copyFile: (srcPath, destDir) =>
    ipcRenderer.invoke('copy-file', srcPath, destDir),

  /**
   * Checks GitHub for a newer release.
   * Triggers an update check against GitHub Releases via electron-updater.
   * Result is delivered asynchronously via onUpdateStatus callback.
   * @returns {Promise<void>}
   */
  checkForUpdates: () =>
    ipcRenderer.invoke('check-for-updates'),

  /**
   * Starts downloading the available update in the background.
   * Progress delivered via onUpdateStatus callback.
   * @returns {Promise<void>}
   */
  startUpdateDownload: () =>
    ipcRenderer.invoke('start-update-download'),

  /**
   * Quits the app and installs the downloaded update.
   * Only call after onUpdateStatus type === 'downloaded'.
   * @returns {Promise<void>}
   */
  installUpdate: () =>
    ipcRenderer.invoke('install-update'),

  /**
   * Registers a callback for update status events pushed from the main process.
   * Status object: { type: 'available'|'progress'|'downloaded'|'error'|'not-available', version?, percent? }
   * @param {Function} callback
   */
  onUpdateStatus: (callback) =>
    ipcRenderer.on('update-status', (_event, status) => callback(status)),

  /**
   * Opens a URL in the user's default browser.
   * Only https:// URLs are accepted by the main process.
   * @param {string} url
   */
  openExternal: (url) =>
    ipcRenderer.invoke('open-external', url),

  /**
   * Renames a PDF file on disk and moves its companion annotations file
   * so saved annotations are preserved.
   * @param {string} oldPath  — Absolute path of the existing PDF
   * @param {string} newName  — New filename (e.g. "Lecture 4.pdf")
   * @returns {Promise<string>} The new absolute path
   */
  renameFile: (oldPath, newName) =>
    ipcRenderer.invoke('rename-file', oldPath, newName),

  /**
   * Packages a PDF and its annotation JSON into a timestamped .vellum archive
   * and writes it to the given directory.
   * Used by the manual export / restore flow.
   * @param {string} pdfPath             — Absolute path of the source PDF
   * @param {string} annotationsJsonPath — Absolute path of the annotation JSON
   * @param {string} destDir             — Directory to write the archive into
   * @returns {Promise<string|null>} Path of the created .vellum, or null if PDF missing
   */
  createVellum: (pdfPath, annotationsJsonPath, destDir) =>
    ipcRenderer.invoke('create-vellum', pdfPath, annotationsJsonPath, destDir),

  /**
   * Synchronously signals the main process to create a .vellum backup of the
   * current note. Uses sendSync so the write completes before the renderer
   * continues (important when called just before closing or switching documents).
   * Fails silently if no backup folder is configured.
   * @param {string} pdfPath         — Absolute path of the open PDF
   * @param {string} annotationsJson — Serialised annotation JSON string (from memory)
   */
  backupOnQuit: (pdfPath, annotationsJson) =>
    ipcRenderer.send('backup-on-quit', pdfPath, annotationsJson),

  /**
   * Extracts a .vellum archive: shows a folder picker, extracts document.pdf
   * to the chosen folder, and returns the PDF path + raw annotations JSON.
   * @param {string} vellumPath — Absolute path of the .vellum file
   * @returns {Promise<{pdfPath:string, annotationsJson:string|null}|null>}
   *          null if the user cancelled the folder dialog
   */
  openVellum: (vellumPath) =>
    ipcRenderer.invoke('open-vellum', vellumPath),

  /**
   * Recursively scans a directory and returns a nested tree of PDFs and
   * subdirectories (max 3 levels deep). Hidden directories are skipped.
   * @param {string} dirPath — Absolute path of the directory to scan
   * @returns {Promise<{files:Array<{name,path}>, subfolders:Array<{name,path,files,subfolders}>}>}
   */
  scanFolderTree: (dirPath) =>
    ipcRenderer.invoke('scan-folder-tree', dirPath),

  /**
   * Scans all stored annotation JSONs for one whose pdfFingerprint matches
   * the given PDF. If found, renames it to the expected path so the app
   * can load it normally. Called when a PDF is opened with no annotations
   * file at its current path (e.g. the file was moved in Explorer).
   * @param {string} pdfPath — Absolute path of the PDF being opened
   * @returns {Promise<string|null>} Recovered path, or null if not found
   */
  recoverAnnotations: (pdfPath) =>
    ipcRenderer.invoke('recover-annotations', pdfPath),

  /**
   * Registers a one-time callback invoked when the app was launched by opening
   * a file (e.g. double-clicking a .vellum in Explorer). The callback receives
   * the absolute file path as its argument.
   * @param {function(string): void} callback
   */
  onOpenFileArgv: (callback) =>
    ipcRenderer.once('open-file-argv', (_event, filePath) => callback(filePath)),

  /**
   * Returns the version string from package.json as reported by the main process.
   * Used by the What's New banner to detect first launch after an update.
   * @returns {Promise<string>}
   */
  getAppVersion: () =>
    ipcRenderer.invoke('get-app-version'),

  /**
   * Returns the version at which the user last saw the What's New banner,
   * or null if they have never seen it.
   * @returns {Promise<string|null>}
   */
  getLastSeenVersion: () =>
    ipcRenderer.invoke('get-last-seen-version'),

  /**
   * Records the current version as the last seen version, dismissing the banner.
   * @returns {Promise<true>}
   */
  dismissWhatsNew: () =>
    ipcRenderer.invoke('dismiss-whats-new'),

});

