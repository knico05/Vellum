/**
 * main.js — Electron main process entry point
 *
 * This is the backend of the app. It runs in Node.js (not in the browser).
 * Responsibilities:
 *   - Create the OS window
 *   - Load the renderer (src/index.html)
 *   - Handle IPC messages from the renderer (file open/read/write)
 *   - Set up the application menu
 *
 * Security model:
 *   - contextIsolation: true  — renderer cannot access Node.js globals directly
 *   - nodeIntegration: false  — renderer cannot require() Node modules
 *   - sandbox: true           — renderer runs in a restricted OS sandbox
 *   - preload.js is the only sanctioned bridge between renderer and Node.js
 *
 * See CLAUDE.md §2 (Electron) for the full rationale.
 */

'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

/**
 * Creates the main application window.
 * Frameless so we can render our own title bar matching the design system.
 * Minimum size prevents the layout from breaking below a usable threshold.
 */
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    frame: false,          // We draw our own title bar in the renderer
    backgroundColor: '#0f0f0f', // --bg-app: prevents white flash on load
    show: false,           // Don't show until 'ready-to-show' fires (no blank flash)
    webPreferences: {
      // preload.js runs before the renderer and exposes a safe, narrow API
      // via contextBridge. It is the ONLY way the renderer talks to Node.js.
      preload: path.join(__dirname, 'preload.js'),

      // contextIsolation: true means the renderer's window object and the
      // preload's Node.js context are separate. Even if the renderer is
      // compromised, it cannot access Node.js APIs.
      contextIsolation: true,

      // nodeIntegration: false means the renderer cannot call require().
      // All Node.js access must go through the IPC bridge in preload.js.
      nodeIntegration: false,

      // sandbox: true runs the renderer in an OS-level sandbox, limiting
      // what system calls it can make. Belt-and-suspenders with contextIsolation.
      sandbox: true,
    },
  });

  // Load the app shell. In production this is a local file; in dev the same.
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Show the window only once it has fully rendered its first frame.
  // This eliminates the white/blank flash that would otherwise appear.
  win.once('ready-to-show', () => {
    win.show();

  // Wire up IPC handlers that need the window reference
  setupIPC(win);

  return win;
}

// ---------------------------------------------------------------------------
// IPC handlers — these are the functions the renderer is allowed to call
// ---------------------------------------------------------------------------

/**
 * Sets up all IPC message handlers.
 * Each handler corresponds to a function exposed via window.api in preload.js.
 *
 * @param {BrowserWindow} win - The main window (needed for dialog parent)
 */
function setupIPC(win) {

  /**
   * openFile — shows the native OS file picker, returns the chosen path.
   * Filtered to PDFs only. Returns null if the user cancels.
   */
  ipcMain.handle('open-file', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Open PDF',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  /**
   * read-file — reads any file from disk, returns its contents as a
   * Uint8Array (safe to pass across the context bridge, unlike Buffer).
   * Used to load both PDF files and annotation JSON files.
   */
  ipcMain.handle('read-file', async (_event, filePath) => {
    try {
      const buffer = fs.readFileSync(filePath);
      // Transfer as Uint8Array — Buffer is a Node.js type and cannot cross
      // the context bridge directly; Uint8Array is a plain JS typed array.
      return new Uint8Array(buffer);
    } catch (err) {
      // Return a structured error so the renderer can show a message
      throw new Error(`Could not read file: ${err.message}`);
    }
  });

  /**
   * write-file — writes a string to disk at the specified path.
   * Used exclusively for saving annotation JSON files.
   */
  ipcMain.handle('write-file', async (_event, filePath, data) => {
    try {
      fs.writeFileSync(filePath, data, 'utf8');
      return true;
    } catch (err) {
      throw new Error(`Could not write file: ${err.message}`);
    }
  });

  /**
   * file-exists — checks whether a file exists at the given path.
   * Used when opening a PDF to check for a companion .annotations.json file.
   */
  ipcMain.handle('file-exists', async (_event, filePath) => {
    return fs.existsSync(filePath);
  });

  /**
   * get-fingerprint — returns a SHA-256 hash of the first 8KB of a file.
   * Used to verify that an annotations file matches its PDF (see CLAUDE.md §6).
   * Runs in the main process because it uses Node's crypto module.
   */
  ipcMain.handle('get-fingerprint', async (_event, filePath) => {
    try {
      const FINGERPRINT_BYTES = 8192; // 8KB sample
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(FINGERPRINT_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, FINGERPRINT_BYTES, 0);
      fs.closeSync(fd);

      return crypto
        .createHash('sha256')
        .update(buffer.subarray(0, bytesRead))
        .digest('hex');
    } catch (err) {
      throw new Error(`Could not fingerprint file: ${err.message}`);
    }
  });

  /**
   * window-control — handles frameless window controls (minimise, maximise, close).
   * The renderer renders these buttons; they send actions here.
   */
  ipcMain.on('window-control', (_event, action) => {
    switch (action) {
      case 'minimise': win.minimize(); break;
      case 'maximise': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
      case 'close':    win.close(); break;
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  // Remove the default application menu — we have our own toolbar UI.
  // Must be called after app is ready; Menu is available from the start but
  // setApplicationMenu has no effect until the app is initialised.
  Menu.setApplicationMenu(null);

  createWindow();

  // macOS: re-create window when dock icon is clicked and no windows are open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed (standard behaviour on Windows/Linux)
app.on('window-all-closed', () => {
  // On macOS apps conventionally stay running until explicitly quit
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
