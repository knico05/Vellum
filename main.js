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
  });

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
   * capture-screen — captures the entire renderer window as a PNG.
   * The renderer is responsible for cropping to the desired region client-side,
   * which avoids coordinate-space ambiguity (logical vs physical pixels) that
   * arises when passing a rect directly to capturePage on HiDPI screens.
   * Returns a Uint8Array of PNG bytes.
   */
  ipcMain.handle('capture-screen', async () => {
    const image = await win.webContents.capturePage();
    return new Uint8Array(image.toPNG());
  });

  /**
   * library-load — reads the library JSON from userData.
   * Returns the parsed object, or null if the file doesn't exist yet.
   * userData is the OS-appropriate app data directory (e.g. %APPDATA% on Windows).
   */
  ipcMain.handle('library-load', async () => {
    const libPath = path.join(app.getPath('userData'), 'library.json');
    try {
      if (!fs.existsSync(libPath)) return null;
      const text = fs.readFileSync(libPath, 'utf8');
      return JSON.parse(text);
    } catch (err) {
      // Corrupt file — treat as empty rather than crashing
      console.error('library-load failed:', err.message);
      return null;
    }
  });

  /**
   * library-save — writes the library object to userData/library.json.
   * @param {object} data — serialisable library object
   */
  ipcMain.handle('library-save', async (_event, data) => {
    const libPath = path.join(app.getPath('userData'), 'library.json');
    try {
      fs.writeFileSync(libPath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (err) {
      throw new Error(`Could not save library: ${err.message}`);
    }
  });

  /**
   * open-folder-dialog — shows a native folder-selection dialog.
   * Used by the library panel to let the user pick a destination for moving files.
   * Returns the chosen directory path, or null if cancelled.
   */
  ipcMain.handle('open-folder-dialog', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /**
   * create-folder — creates a new directory at the given path.
   * Uses recursive:true so intermediate directories are created as needed.
   */
  ipcMain.handle('create-folder', async (_event, dirPath) => {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      return true;
    } catch (err) {
      throw new Error(`Could not create folder: ${err.message}`);
    }
  });

  /**
   * move-file — moves (renames) a file from srcPath to destPath.
   * If destPath is a directory, the file is moved inside it keeping its name.
   * Returns the final destination path.
   */
  ipcMain.handle('move-file', async (_event, srcPath, destPath) => {
    try {
      let finalDest = destPath;
      // If destPath is a directory, keep the filename
      if (fs.existsSync(destPath) && fs.statSync(destPath).isDirectory()) {
        const filename = path.basename(srcPath);
        finalDest = path.join(destPath, filename);
      }
      fs.renameSync(srcPath, finalDest);
      return finalDest;
    } catch (err) {
      throw new Error(`Could not move file: ${err.message}`);
    }
  });

  /**
   * get-annotations-path — returns the path where annotations for a given PDF
   * should be stored, creating the directory if it doesn't exist yet.
   *
   * Files are stored in: userData/annotations/<sha256(normalised_pdf_path)>.json
   *
   * Normalisation: backslashes → forward slashes before hashing, so the same
   * file produces the same key regardless of how the OS reports the separator.
   *
   * Using a hash of the path (rather than the PDF fingerprint) means annotations
   * survive if the PDF is re-exported or slightly modified, as long as the file
   * path stays the same — which matches user expectations.
   *
   * @param {string} pdfPath — Absolute path to the PDF file
   * @returns {string} Absolute path to the .json annotations file
   */
  ipcMain.handle('get-annotations-path', async (_event, pdfPath) => {
    const annotationsDir = path.join(app.getPath('userData'), 'annotations');
    if (!fs.existsSync(annotationsDir)) {
      fs.mkdirSync(annotationsDir, { recursive: true });
    }
    // Normalise path separators before hashing so Windows paths are consistent
    const normalised = pdfPath.replace(/\\/g, '/');
    const hash       = crypto.createHash('sha256').update(normalised).digest('hex');
    return path.join(annotationsDir, `${hash}.json`);
  });

  /**
   * save-pdf-dialog — shows a native Save As dialog filtered to PDF files.
   * Used by the export feature to let the user choose where to save the
   * flattened PDF. Returns the chosen path, or null if cancelled.
   * @param {string} defaultName — Suggested filename (e.g. "lecture3-annotated.pdf")
   */
  ipcMain.handle('save-pdf-dialog', async (_event, defaultName) => {
    const result = await dialog.showSaveDialog(win, {
      title:       'Export as PDF',
      defaultPath: defaultName,
      filters:     [{ name: 'PDF Files', extensions: ['pdf'] }],
    });
    return result.canceled ? null : result.filePath;
  });

  /**
   * write-binary — writes a Uint8Array to disk as raw binary.
   * Separate from write-file (which uses utf8 encoding) because PDF bytes
   * must not be re-encoded as UTF-8 text.
   * @param {string}     filePath — Absolute path to write to
   * @param {Uint8Array} data     — Raw bytes
   */
  ipcMain.handle('write-binary', async (_event, filePath, data) => {
    try {
      fs.writeFileSync(filePath, Buffer.from(data));
      return true;
    } catch (err) {
      throw new Error(`Could not write file: ${err.message}`);
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
