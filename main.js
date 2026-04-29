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

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');


// Prevent Windows Xbox Game Bar from injecting its overlay into the Electron
// window. Without this, Chromium fires an ms-gamingoverlay:// protocol call
// on startup which Windows intercepts and shows a dialog.
app.commandLine.appendSwitch('disable-features', 'GameOverlayEmbeddedBrowser,GameBarBroadcastCapture,HardwareMediaKeyHandling,MediaSessionService,GameBar');

// Set the App User Model ID to match the installer appId exactly.
// This is what Windows uses to group the running window with the taskbar
// shortcut — a mismatch causes two separate taskbar entries.
app.setAppUserModelId('com.knico05.vellum');

// Enforce single instance. Without this, every time Windows routes the
// ms-gamingoverlay:// protocol to Vellum it spawns a second copy, which
// re-registers the protocol handler and triggers the picker dialog in a loop.
// With the lock, the second instance quits immediately and the first instance
// receives a 'second-instance' event instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // We are the second instance — quit silently.
  app.quit();
}

app.on('second-instance', (_event, argv) => {
  // A second instance was launched (e.g. by Windows routing ms-gamingoverlay://
  // or by the user double-clicking a file). Bring the existing window to front.
  const existing = BrowserWindow.getAllWindows()[0];
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  }
  // If a real file path was passed, open it in the existing window.
  const filePath = _getArgvFilePath(argv);
  if (filePath && !filePath.startsWith('ms-gamingoverlay')) {
    existing?.webContents.send('open-file-argv', filePath);
  }
});

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

      // Enable Chromium's built-in spell checker. Red underlines appear in
      // contenteditable elements; right-click shows correction suggestions via
      // the context-menu handler below.
      spellcheck: true,
    },
  });

  // Spell-check context menu — shows suggestions and language switcher when
  // the user right-clicks a misspelled word in any contenteditable element.
  win.webContents.on('context-menu', (_e, params) => {
    if (!params.misspelledWord && params.dictionarySuggestions.length === 0) return;
    const template = [
      ...params.dictionarySuggestions.map(s => ({
        label: s,
        click: () => win.webContents.replaceMisspelling(s),
      })),
      { type: 'separator' },
      {
        label: 'Add to dictionary',
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      },
      { type: 'separator' },
      { label: 'English', click: () => win.webContents.session.setSpellCheckerLanguages(['en-US']) },
      { label: 'German',  click: () => win.webContents.session.setSpellCheckerLanguages(['de-DE']) },
      { label: 'French',  click: () => win.webContents.session.setSpellCheckerLanguages(['fr-FR']) },
      { label: 'Spanish', click: () => win.webContents.session.setSpellCheckerLanguages(['es-ES']) },
      { label: 'Dutch',   click: () => win.webContents.session.setSpellCheckerLanguages(['nl-NL']) },
    ];
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // Block ms-gamingoverlay:// before Chromium hands it to the Windows shell.
  // This fires synchronously in the renderer process — calling preventDefault()
  // cancels the navigation entirely so Windows never sees the protocol request.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('ms-gamingoverlay:')) event.preventDefault();
  });

  // Load the app shell. In production this is a local file; in dev the same.
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Show the window only once it has fully rendered its first frame.
  // This eliminates the white/blank flash that would otherwise appear.
  win.once('ready-to-show', () => {
    win.maximize();
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
/**
 * Builds a minimal valid single-page blank A4 PDF as a binary string.
 *
 * The PDF spec requires byte offsets in the xref table to be exact, so we
 * build the body first, measure each object's offset, then append the xref.
 *
 * @returns {string} Binary string suitable for fs.writeFileSync(path, data, 'binary')
 */
function _buildBlankPdf() {
  const W = 595, H = 842; // A4 at 72 dpi

  // A random 16-byte hex ID embedded in the PDF trailer.
  // Without this, every blank PDF is byte-for-byte identical, causing the
  // annotation recovery mechanism to incorrectly match annotations from one
  // blank file to another (they share the same content fingerprint).
  // The /ID array is standard PDF spec (§14.4) and accepted by all readers.
  const docId = crypto.randomBytes(16).toString('hex').toUpperCase();

  // Build the body objects first so we can measure their offsets
  const obj1 = '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n';
  const obj2 = '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n';
  const obj3 = `3 0 obj<</Type/Page/MediaBox[0 0 ${W} ${H}]/Parent 2 0 R>>endobj\n`;

  const header = '%PDF-1.4\n';

  const off1 = header.length;
  const off2 = off1 + obj1.length;
  const off3 = off2 + obj2.length;
  const xrefOff = off3 + obj3.length;

  const pad = (n) => String(n).padStart(10, '0');

  const xref = [
    'xref\n',
    '0 4\n',
    '0000000000 65535 f \n',
    `${pad(off1)} 00000 n \n`,
    `${pad(off2)} 00000 n \n`,
    `${pad(off3)} 00000 n \n`,
    `trailer<</Size 4/Root 1 0 R/ID[<${docId}><${docId}>]>>\n`,
    'startxref\n',
    `${xrefOff}\n`,
    '%%EOF\n',
  ].join('');

  return header + obj1 + obj2 + obj3 + xref;
}

function setupIPC(win) {

  /**
   * openFile — shows the native OS file picker.
   * Accepts both PDF files and .vellum archives.
   * Returns the chosen file path, or null if cancelled.
   */
  ipcMain.handle('open-file', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Open file',
      filters: [{ name: 'Vellum & PDF Files', extensions: ['pdf', 'vellum'] }],
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

      // Move companion annotations file (stored by sha256 of the PDF path in userData)
      const annotationsDir = path.join(app.getPath('userData'), 'annotations');
      const oldHash = crypto.createHash('sha256').update(srcPath.replace(/\\/g, '/')).digest('hex');
      const newHash = crypto.createHash('sha256').update(finalDest.replace(/\\/g, '/')).digest('hex');
      const oldAnno = path.join(annotationsDir, `${oldHash}.json`);
      const newAnno = path.join(annotationsDir, `${newHash}.json`);
      if (fs.existsSync(oldAnno) && !fs.existsSync(newAnno)) {
        fs.renameSync(oldAnno, newAnno);
      }

      return finalDest;
    } catch (err) {
      throw new Error(`Could not move file: ${err.message}`);
    }
  });

  /**
   * rename-file — renames a PDF to a new name in the same directory.
   * Also renames its companion annotations file (stored by path-hash in userData)
   * so saved annotations are not lost.
   *
   * @param {string} oldPath  — Absolute path of the existing PDF
   * @param {string} newName  — New filename (with or without .pdf extension)
   * @returns {Promise<string>} The new absolute path
   */
  ipcMain.handle('rename-file', async (_event, oldPath, newName) => {
    try {
      const dir     = path.dirname(oldPath);
      const ext     = path.extname(oldPath);
      const safeName = newName.endsWith(ext) ? newName : newName + ext;
      const newPath = path.join(dir, safeName);

      if (fs.existsSync(newPath)) {
        throw new Error('A file with that name already exists.');
      }

      fs.renameSync(oldPath, newPath);

      // Rename companion annotations file (stored by sha256 of the PDF path)
      const annotationsDir = path.join(app.getPath('userData'), 'annotations');
      const oldNorm  = oldPath.replace(/\\/g, '/');
      const newNorm  = newPath.replace(/\\/g, '/');
      const oldHash  = crypto.createHash('sha256').update(oldNorm).digest('hex');
      const newHash  = crypto.createHash('sha256').update(newNorm).digest('hex');
      const oldAnno  = path.join(annotationsDir, `${oldHash}.json`);
      const newAnno  = path.join(annotationsDir, `${newHash}.json`);

      if (fs.existsSync(oldAnno) && !fs.existsSync(newAnno)) {
        fs.renameSync(oldAnno, newAnno);
      }

      return newPath;
    } catch (err) {
      throw new Error(`Could not rename file: ${err.message}`);
    }
  });

  /**
   * create-blank-pdf — generates a minimal valid single-page blank PDF at the
   * given path.  The file can be opened immediately and the user adds their own
   * pages via the "New Page" button.  Refuses to overwrite an existing file.
   *
   * The PDF is built as a plain ASCII string with exact byte offsets so it is
   * accepted by PDF.js without any external dependencies.
   *
   * @param {string} filePath — Absolute destination path (must end in .pdf)
   * @returns {Promise<true>}
   */
  ipcMain.handle('create-blank-pdf', async (_event, filePath) => {
    if (fs.existsSync(filePath)) {
      throw new Error('A file with that name already exists.');
    }
    try {
      fs.writeFileSync(filePath, _buildBlankPdf(), 'binary');
      return true;
    } catch (err) {
      throw new Error(`Could not create file: ${err.message}`);
    }
  });

  /**
   * delete-file — permanently removes a file from disk.
   * Shows a native confirmation dialog before deleting.
   * @param {string} filePath — Absolute path of the file to delete
   * @returns {Promise<boolean>} true if deleted, false if user cancelled
   */
  ipcMain.handle('delete-file', async (_event, filePath) => {
    const { response } = await dialog.showMessageBox(win, {
      type:    'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId:  1,
      title:   'Delete file',
      message: `Delete "${path.basename(filePath)}"?`,
      detail:  'This will permanently remove the file from disk.',
    });
    if (response !== 0) return false; // user chose Cancel
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (err) {
      throw new Error(`Could not delete file: ${err.message}`);
    }
  });

  /**
   * scan-folder — lists all PDF files in a directory (non-recursive).
   * Returns an array of absolute file paths.
   */
  ipcMain.handle('scan-folder', async (_event, dirPath) => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
        .map(e => path.join(dirPath, e.name));
    } catch (err) {
      throw new Error(`Could not scan folder: ${err.message}`);
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
   * save-vellum-dialog — shows a Save As dialog for .vellum files.
   * @param {string} defaultName — Suggested filename (e.g. "lecture3.vellum")
   * @returns {Promise<string|null>} Chosen path, or null if cancelled
   */
  ipcMain.handle('save-vellum-dialog', async (_event, defaultName) => {
    const result = await dialog.showSaveDialog(win, {
      title:       'Export as Vellum',
      defaultPath: defaultName,
      filters:     [{ name: 'Vellum Files', extensions: ['vellum'] }],
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

  // ---------------------------------------------------------------------------
  // Auto-updater (electron-updater + GitHub Releases)
  // ---------------------------------------------------------------------------

  // Disable auto-download — we show a badge first, user clicks to download.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  const _sendUpdateStatus = (status) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) w.webContents.send('update-status', status);
  };

  autoUpdater.on('update-available', (info) => {
    _sendUpdateStatus({ type: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    _sendUpdateStatus({ type: 'not-available' });
  });

  autoUpdater.on('download-progress', (progress) => {
    _sendUpdateStatus({ type: 'progress', percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', () => {
    _sendUpdateStatus({ type: 'downloaded' });
  });

  autoUpdater.on('error', () => {
    _sendUpdateStatus({ type: 'error' });
  });

  // check-for-updates — called by renderer on startup (delayed 4s).
  ipcMain.handle('check-for-updates', async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Offline or GitHub unreachable — fail silently
    }
  });

  // start-update-download — called when user clicks the update badge.
  ipcMain.handle('start-update-download', async () => {
    try {
      await autoUpdater.downloadUpdate();
    } catch {
      _sendUpdateStatus({ type: 'error' });
    }
  });

  // install-update — called when user clicks "Restart to update".
  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall();
  });

  /**
   * open-external — opens a URL in the user's default browser.
   * The renderer cannot call shell.openExternal directly (sandboxed), so it
   * goes through this handler instead.
   */
  ipcMain.handle('open-external', (_event, url) => {
    // Only allow https:// URLs — prevents accidental file:// or js: navigation
    if (typeof url === 'string' && url.startsWith('https://')) {
      shell.openExternal(url);
    }
  });

  // ---------------------------------------------------------------------------
  // Auto-backup handlers
  // ---------------------------------------------------------------------------

  const _settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

  function _loadSettings() {
    try {
      if (fs.existsSync(_settingsPath())) {
        return JSON.parse(fs.readFileSync(_settingsPath(), 'utf8'));
      }
    } catch (_) {}
    return {};
  }

  function _saveSettings(obj) {
    fs.writeFileSync(_settingsPath(), JSON.stringify(obj, null, 2), 'utf8');
  }

  /**
   * get-backup-dir — returns the configured auto-backup folder path, or null.
   */
  ipcMain.handle('get-backup-dir', () => {
    return _loadSettings().backupDir ?? null;
  });

  /**
   * check-legacy-backups — counts non-.vellum files in the backup folder.
   * Used to decide whether to show the one-time migration prompt.
   * Returns 0 if no backup folder is set, folder is missing, or all files are .vellum.
   */
  ipcMain.handle('check-legacy-backups', () => {
    const { backupDir, backupMigrationDone } = _loadSettings();
    if (backupMigrationDone || !backupDir) return 0;
    try {
      return fs.readdirSync(backupDir)
        .filter(name => !name.toLowerCase().endsWith('.vellum'))
        .length;
    } catch { return 0; }
  });

  /**
   * clean-legacy-backups — deletes all non-.vellum files from the backup folder,
   * then marks the migration as done so the prompt never shows again.
   * Skips files it cannot delete (permissions etc.) rather than throwing.
   */
  ipcMain.handle('clean-legacy-backups', () => {
    const settings = _loadSettings();
    const { backupDir } = settings;
    if (backupDir) {
      try {
        const entries = fs.readdirSync(backupDir);
        for (const name of entries) {
          if (!name.toLowerCase().endsWith('.vellum')) {
            try { fs.unlinkSync(path.join(backupDir, name)); } catch { /* skip locked files */ }
          }
        }
      } catch { /* folder gone or unreadable — still mark done */ }
    }
    settings.backupMigrationDone = true;
    _saveSettings(settings);
    return true;
  });

  /**
   * dismiss-legacy-backup-prompt — records that the user chose to keep old files,
   * so the prompt never shows again.
   */
  ipcMain.handle('dismiss-legacy-backup-prompt', () => {
    const settings = _loadSettings();
    settings.backupMigrationDone = true;
    _saveSettings(settings);
    return true;
  });

  /**
   * get-app-version — returns the current app version from package.json.
   */
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  /**
   * get-last-seen-version — returns the version the user last acknowledged in
   * the What's New banner, or null if never shown.
   */
  ipcMain.handle('get-last-seen-version', () => {
    return _loadSettings().lastSeenVersion ?? null;
  });

  /**
   * dismiss-whats-new — records the current version as seen so the banner
   * never shows again for this version.
   */
  ipcMain.handle('dismiss-whats-new', () => {
    const settings = _loadSettings();
    settings.lastSeenVersion = app.getVersion();
    _saveSettings(settings);
    return true;
  });

  /**
   * set-backup-dir — sets or clears the auto-backup folder path.
   * Pass null to disable backup.
   * @param {string|null} dirPath
   */
  ipcMain.handle('set-backup-dir', (_event, dirPath) => {
    const settings = _loadSettings();
    if (dirPath) settings.backupDir = dirPath;
    else delete settings.backupDir;
    _saveSettings(settings);
    return true;
  });

  /**
   * copy-file — copies a single file into a destination directory.
   * Used by auto-backup to copy annotation JSON and PDF to the backup folder.
   * Silently skips if srcPath does not exist (e.g. no PDF open yet).
   * @param {string} srcPath  — absolute path of the file to copy
   * @param {string} destDir  — absolute path of the destination directory
   */
  ipcMain.handle('copy-file', async (_event, srcPath, destDir) => {
    if (!fs.existsSync(srcPath)) return true; // nothing to copy — not an error
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(srcPath));
    fs.copyFileSync(srcPath, dest);
    return true;
  });

  /**
   * create-vellum — packages a PDF and its annotation JSON into a single
   * .vellum archive (ZIP) and writes it to the destination directory.
   *
   * Filename format: {pdf-basename}_{ISO-timestamp}.vellum
   * Archive contents:
   *   document.pdf      — the original PDF
   *   annotations.json  — annotation data (omitted if file doesn't exist)
   *   meta.json         — { title, originalPath, createdAt, appVersion }
   *
   * Used by auto-backup so each backup is a self-contained, timestamped file.
   *
   * @param {string} pdfPath            — absolute path of the source PDF
   * @param {string} annotationsJsonPath — absolute path of the annotation JSON
   * @param {string} destDir            — directory to write the .vellum into
   * @returns {string|null} path of the created .vellum, or null if PDF missing
   */
  ipcMain.handle('create-vellum', async (_event, pdfPath, annotationsJsonPath, destDir) => {
    if (!fs.existsSync(pdfPath)) return null;

    const zip       = new AdmZip();
    const baseName  = path.basename(pdfPath, '.pdf');
    const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
    const vellumName = `${baseName}_${timestamp}.vellum`;

    zip.addLocalFile(pdfPath, '', 'document.pdf');

    if (fs.existsSync(annotationsJsonPath)) {
      zip.addLocalFile(annotationsJsonPath, '', 'annotations.json');
    }

    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    const meta = JSON.stringify({
      title:        baseName,
      originalPath: pdfPath,
      createdAt:    new Date().toISOString(),
      appVersion:   packageJson.version,
    });
    zip.addFile('meta.json', Buffer.from(meta, 'utf8'));

    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, vellumName);
    zip.writeZip(destPath);
    return destPath;
  });

  /**
   * open-vellum — extracts a .vellum archive chosen by the user.
   *
   * Shows a folder picker so the user can choose where to place the PDF.
   * Extracts document.pdf there, reads annotations.json from the archive,
   * and returns both so the renderer can load the note normally.
   *
   * @param {string} vellumPath — absolute path of the .vellum file
   * @returns {{ pdfPath: string, annotationsJson: string|null }|null}
   *          null if the user cancelled the folder dialog or the archive is invalid
   */
  ipcMain.handle('open-vellum', async (_event, vellumPath) => {
    // Ask user where to place the extracted PDF
    const folderResult = await dialog.showOpenDialog(win, {
      title: 'Choose folder to extract PDF into',
      properties: ['openDirectory'],
    });
    if (folderResult.canceled || folderResult.filePaths.length === 0) return null;

    const extractDir = folderResult.filePaths[0];
    const zip = new AdmZip(vellumPath);

    const pdfEntry = zip.getEntry('document.pdf');
    if (!pdfEntry) throw new Error('Invalid .vellum file: document.pdf not found inside archive');

    // Derive PDF filename: strip the timestamp suffix from the archive name
    let pdfName = path.basename(vellumPath, '.vellum').replace(/_\d{4}-\d{2}-\d{2}T[\d-]+$/, '') + '.pdf';
    try {
      const metaEntry = zip.getEntry('meta.json');
      if (metaEntry) {
        const meta = JSON.parse(metaEntry.getData().toString('utf8'));
        if (meta.title) pdfName = `${meta.title}.pdf`;
      }
    } catch { /* ignore corrupt meta */ }

    const pdfPath = path.join(extractDir, pdfName);
    fs.writeFileSync(pdfPath, pdfEntry.getData());

    const annoEntry = zip.getEntry('annotations.json');
    const annotationsJson = annoEntry ? annoEntry.getData().toString('utf8') : null;

    return { pdfPath, annotationsJson };
  });

  /**
   * Recursively scans a directory for PDFs and subdirectories (up to 3 levels
   * deep). Hidden directories (name starting with '.') are skipped.
   *
   * @param {string} dirPath — absolute directory path to scan
   * @param {number} depth   — current recursion depth (start at 0)
   * @returns {{ files: Array<{name,path}>, subfolders: Array<{name,path,...}> }}
   */
  function _scanFolderTree(dirPath, depth) {
    if (depth > 3) return { files: [], subfolders: [] };
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return { files: [], subfolders: [] };
    }
    const files = entries
      .filter(e => e.isFile() && /\.(pdf|vellum)$/i.test(e.name))
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }));
    const subfolders = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => {
        const subPath = path.join(dirPath, e.name);
        return { name: e.name, path: subPath, ..._scanFolderTree(subPath, depth + 1) };
      });
    return { files, subfolders };
  }

  /**
   * scan-folder-tree — recursive variant of scan-folder.
   * Returns a nested tree of PDFs and subdirectories.
   * @param {string} dirPath — absolute path to scan
   * @returns {{ files: Array<{name,path}>, subfolders: Array<{name,path,files,subfolders}> }}
   */
  ipcMain.handle('scan-folder-tree', (_event, dirPath) => {
    return _scanFolderTree(dirPath, 0);
  });

  /**
   * recover-annotations — finds an orphaned annotations JSON whose stored
   * pdfFingerprint matches the given PDF, then renames it to the expected path.
   *
   * Called when a PDF is opened but no annotations file exists at the expected
   * path (sha256 of the current absolute path). This happens when the user
   * moves or renames the PDF outside of the app.
   *
   * @param {string} pdfPath — Absolute path of the PDF being opened
   * @returns {string|null} The recovered annotations path, or null if not found
   */
  ipcMain.handle('recover-annotations', async (_event, pdfPath) => {
    const annotationsDir = path.join(app.getPath('userData'), 'annotations');
    const expectedHash   = crypto.createHash('sha256').update(pdfPath.replace(/\\/g, '/')).digest('hex');
    const expectedPath   = path.join(annotationsDir, `${expectedHash}.json`);

    // Already in the right place — nothing to do
    if (fs.existsSync(expectedPath)) return null;

    // Compute content fingerprint of the PDF (first 8 KB)
    let fingerprint;
    try {
      const fd       = fs.openSync(pdfPath, 'r');
      const buf      = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      fingerprint = crypto.createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex');
    } catch {
      return null;
    }

    // Scan all annotation JSONs for a matching fingerprint
    let entries;
    try { entries = fs.readdirSync(annotationsDir); } catch { return null; }

    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const candidate = path.join(annotationsDir, name);
      if (candidate === expectedPath) continue;
      try {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (data.pdfFingerprint === fingerprint) {
          // Only recover if the PDF this JSON was originally saved for no longer
          // exists on disk. If it still exists, this is a different file that
          // happens to have identical content (e.g. two newly-created blank PDFs)
          // and its annotations must not be stolen.
          const originalPath = typeof data.pdfPath === 'string' ? data.pdfPath : null;
          if (originalPath && fs.existsSync(originalPath)) continue;
          fs.renameSync(candidate, expectedPath);
          return expectedPath;
        }
      } catch { /* corrupt or unreadable — skip */ }
    }

    return null;
  });

  // ---------------------------------------------------------------------------
  // Handwriting recognition helpers
  // ---------------------------------------------------------------------------

  /**
   * Normalises an array of strokes so the bounding box of the entire group
   * starts at (0, 0). Preserving relative positions between strokes is critical
   * for the Windows Ink recogniser to understand multi-stroke letters and words.
   *
   * @param {Array<Array<{x:number,y:number}>>} strokes
   * @returns {Array<Array<{x:number,y:number}>>}
   */
  function _normalizeStrokes(strokes) {
    let minX = Infinity, minY = Infinity;
    for (const stroke of strokes) {
      for (const pt of stroke) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
      }
    }
    if (!isFinite(minX)) return strokes;
    return strokes.map(s => s.map(pt => ({ x: pt.x - minX, y: pt.y - minY })));
  }

  /**
   * Groups strokes into word-sized clusters using a line-first, word-second
   * strategy that mirrors how ink recognizers expect input.
   *
   * Algorithm:
   *   1. Compute bounding box per stroke.
   *   2. Group strokes into lines: two strokes share a line when their Y-center
   *      distance ≤ lineEps (0.7× median stroke height). Only Y is used — this
   *      prevents diagonal merging across lines regardless of horizontal proximity.
   *   3. Within each line, sort left→right by minX and split into words when the
   *      horizontal gap between adjacent strokes exceeds wordGap (0.8× medH).
   *      Character height ≈ character width for most handwriting, so ~1 char
   *      height is a reliable word-boundary threshold.
   *   4. After word clusters are formed, absorb tiny orphaned single strokes
   *      (height < 0.25× medH — dots on i/j, accents, periods) into the nearest
   *      word cluster by X-center proximity.
   *   5. Sort all clusters in reading order (top→bottom, left→right within a line).
   *
   * Single-stroke clusters that are NOT tiny dots are kept as-is — they may be
   * real letters (I, l, 1, dash) and must be sent to the recognizer.
   *
   * @param {Array<Array<{x:number,y:number}>>} strokes  raw canvas-coord strokes
   * @returns {Array<{strokes:Array, bounds:{minX,maxX,minY,maxY}}>}
   *          Sorted in reading order.
   */
  function _clusterStrokes(strokes) {
    const n = strokes.length;
    if (n === 0) return [];

    // -- Step 1: bounding box per stroke --
    const boxes = strokes.map(pts => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      // Ensure non-degenerate box for single-point strokes
      if (minX === maxX) { minX -= 1; maxX += 1; }
      if (minY === maxY) { minY -= 1; maxY += 1; }
      return { minX, maxX, minY, maxY, cy: (minY + maxY) / 2 };
    });

    // Median stroke height (ignore zero-height degenerate strokes)
    const heights = boxes.map(b => b.maxY - b.minY).filter(h => h > 2).sort((a, b) => a - b);
    const medH    = heights.length ? heights[Math.floor(heights.length / 2)] : 20;
    // lineEps: max Y-center gap between consecutive strokes (sorted) to be on the
    // same line. Using 0.5× medH so that normal line spacing (≥ 1.5× medH apart)
    // always creates a new line, while strokes within the same text line stay together.
    const lineEps = medH * 0.5;
    // wordGap: min X-gap between adjacent strokes (within a line) to treat as a
    // word boundary. ~1 character width, which empirically equals ~1 char height.
    const wordGap = medH * 0.8;

    // -- Step 2: group into lines by sorting on Y-center and splitting on gaps --
    // Union-find is intentionally avoided here: it chains transitively, so stroke A
    // merging with B and B merging with C would put A and C together even when
    // |cy_A - cy_C| >> lineEps. Sorting + gap splitting has no such runaway.
    const sortedByY = [...Array(n).keys()].sort((a, b) => boxes[a].cy - boxes[b].cy);
    const lineGroups = [[ sortedByY[0] ]];
    for (let k = 1; k < sortedByY.length; k++) {
      const prev = sortedByY[k - 1];
      const curr = sortedByY[k];
      if (boxes[curr].cy - boxes[prev].cy > lineEps) {
        lineGroups.push([ curr ]);
      } else {
        lineGroups[lineGroups.length - 1].push(curr);
      }
    }

    // -- Step 3: within each line, split into word clusters by X-gap --
    const wordClusters = []; // { strokeIdxs: number[], bounds }

    for (const idxs of lineGroups.values()) {
      // Sort left-to-right
      idxs.sort((a, b) => boxes[a].minX - boxes[b].minX);

      let current = [idxs[0]];
      for (let k = 1; k < idxs.length; k++) {
        const prev = idxs[k - 1];
        const curr = idxs[k];
        const xGap = boxes[curr].minX - boxes[prev].maxX;
        if (xGap > wordGap) {
          // Start a new word cluster
          wordClusters.push({ strokeIdxs: current });
          current = [curr];
        } else {
          current.push(curr);
        }
      }
      wordClusters.push({ strokeIdxs: current });
    }

    // -- Step 4: absorb tiny dot/accent strokes into nearest word cluster --
    // Identify orphan single-stroke dots (very short height)
    const dotThreshold = medH * 0.25;
    const dotIdxs      = [];
    const wordIdxSets  = wordClusters.map(wc => new Set(wc.strokeIdxs));

    for (let i = 0; i < n; i++) {
      const h = boxes[i].maxY - boxes[i].minY;
      if (h < dotThreshold) dotIdxs.push(i);
    }

    for (const di of dotIdxs) {
      // Only absorb if the dot is currently alone in its word cluster
      const ownerCluster = wordClusters.find(wc => wc.strokeIdxs.includes(di));
      if (!ownerCluster || ownerCluster.strokeIdxs.length > 1) continue; // already grouped

      const dotCx = (boxes[di].minX + boxes[di].maxX) / 2;
      let bestCluster = null;
      let bestDist    = Infinity;

      for (const wc of wordClusters) {
        if (wc === ownerCluster) continue;
        const wcMinX = Math.min(...wc.strokeIdxs.map(i => boxes[i].minX));
        const wcMaxX = Math.max(...wc.strokeIdxs.map(i => boxes[i].maxX));
        const wcCx   = (wcMinX + wcMaxX) / 2;
        const dist   = Math.abs(dotCx - wcCx);
        if (dist < bestDist && dist < medH * 2) {
          bestDist    = dist;
          bestCluster = wc;
        }
      }

      if (bestCluster) {
        bestCluster.strokeIdxs.push(di);
        // Remove the now-empty singleton cluster
        const ownerIdx = wordClusters.indexOf(ownerCluster);
        if (ownerIdx !== -1) wordClusters.splice(ownerIdx, 1);
      }
    }

    // -- Step 5: build final cluster objects with bounds and sort in reading order --
    const clusters = wordClusters.map(wc => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const i of wc.strokeIdxs) {
        const b = boxes[i];
        if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX;
        if (b.minY < minY) minY = b.minY; if (b.maxY > maxY) maxY = b.maxY;
      }
      return {
        strokes: wc.strokeIdxs.map(i => strokes[i]),
        bounds:  { minX, maxX, minY, maxY },
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
      };
    });

    clusters.sort((a, b) => Math.abs(a.cy - b.cy) > medH ? a.cy - b.cy : a.cx - b.cx);
    return clusters;
  }

  /**
   * Clusters strokes, recognises each cluster independently, and returns
   * the combined text plus per-segment bounds (in original canvas coords).
   *
   * @param {Array<Array<{x:number,y:number}>>} strokes
   * @returns {Promise<{text:string, segments:Array<{text:string,bounds:object}>}>}
   */
  async function _recognizePage(strokes) {
    const clusters = _clusterStrokes(strokes);
    const segments = [];

    for (const cluster of clusters) {
      const norm = _normalizeStrokes(cluster.strokes);
      const text = await _recognizeInkStrokes(norm);
      if (text && text.trim()) {
        segments.push({ text: text.trim(), bounds: cluster.bounds });
      }
    }

    return { text: segments.map(s => s.text).join(' '), segments };
  }

  /**
   * Runs the PowerShell ink recogniser on a set of normalised strokes.
   * Writes a temp JSON file, spawns recognize.ps1, collects stdout.
   *
   * @param {Array<Array<{x:number,y:number}>>} normalizedStrokes
   * @returns {Promise<string>} recognised text, or '' on any failure
   */
  async function _recognizeInkStrokes(normalizedStrokes) {
    const tmpPath = path.join(app.getPath('temp'), `vellum_ink_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(normalizedStrokes), 'utf8');
    } catch {
      return '';
    }

    const psScript = path.join(__dirname, 'scripts', 'recognize.ps1');

    return new Promise((resolve) => {
      const proc = spawn('powershell', [
        '-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', psScript, '-InputFile', tmpPath,
      ], { timeout: 15000 });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
      proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
      proc.on('close', (code) => {
        try { fs.unlinkSync(tmpPath); } catch { /* temp cleanup best-effort */ }
        if (stderr.trim()) console.error('[recognize.ps1 stderr]', stderr.trim());
        if (code !== 0) console.warn('[recognize.ps1] exit code', code, '| stdout:', stdout.trim());
        else console.log('[recognize.ps1] result:', stdout.trim() || '(empty)');
        resolve(stdout.trim());
      });
      proc.on('error', (err) => {
        console.error('[recognize.ps1] spawn error:', err.message);
        try { fs.unlinkSync(tmpPath); } catch {}
        resolve('');
      });
    });
  }

  /**
   * Recursively collects all .vellum file paths from a folder tree node
   * returned by _scanFolderTree().
   *
   * @param {{ files: Array<{path:string,name:string}>, subfolders: Array }} node
   * @returns {string[]}
   */
  function _collectVellumPaths(node) {
    const paths = [];
    for (const f of node.files ?? []) {
      if (f.name.toLowerCase().endsWith('.vellum')) paths.push(f.path);
    }
    for (const sub of node.subfolders ?? []) {
      paths.push(..._collectVellumPaths(sub));
    }
    return paths;
  }

  // ---------------------------------------------------------------------------
  // Handwriting search IPC handlers
  // ---------------------------------------------------------------------------

  /**
   * recognize-handwriting — runs the PowerShell ink recogniser on caller-supplied
   * strokes. Strokes should be grouped per page (all strokes on a page together)
   * so the recogniser can resolve multi-stroke characters and words correctly.
   *
   * @param {Array<Array<{x:number,y:number,pressure?:number}>>} strokes
   *   Array of strokes; each stroke is an array of canvas-space points.
   *   The caller is responsible for grouping strokes by page before calling.
   * @returns {Promise<string>} recognised text
   */
  ipcMain.handle('recognize-handwriting', async (_event, strokes) => {
    if (!Array.isArray(strokes) || strokes.length === 0) return { text: '', segments: [] };
    // Strip pressure — recognition only needs x, y
    const xyOnly = strokes.map(s => s.map(pt => ({ x: pt.x, y: pt.y })));
    return _recognizePage(xyOnly);
  });

  /**
   * list-vellum-files-for-search — collects all .vellum file paths from:
   *   1. All pinned library folders (read from userData/library.json)
   *   2. The configured auto-backup folder (from userData/settings.json)
   * Deduplicates by resolved absolute path.
   *
   * @returns {string[]} deduplicated list of absolute .vellum paths
   */
  ipcMain.handle('list-vellum-files-for-search', () => {
    const seen    = new Set();
    const results = [];

    const addPath = (p) => {
      const resolved = path.resolve(p);
      if (!seen.has(resolved) && fs.existsSync(resolved)) {
        seen.add(resolved);
        results.push(resolved);
      }
    };

    // Pinned library folders — read from userData/library.json
    try {
      const libPath = path.join(app.getPath('userData'), 'library.json');
      const lib     = fs.existsSync(libPath)
        ? JSON.parse(fs.readFileSync(libPath, 'utf8'))
        : { folders: [] };
      for (const folder of (lib.folders ?? [])) {
        try {
          const tree = _scanFolderTree(folder.path, 0);
          for (const p of _collectVellumPaths(tree)) addPath(p);
        } catch { /* unreadable folder — skip */ }
      }
    } catch { /* library.json unreadable — skip */ }

    // Backup folder
    const backupDir = _loadSettings().backupDir;
    if (backupDir) {
      try {
        for (const name of fs.readdirSync(backupDir)) {
          if (name.toLowerCase().endsWith('.vellum')) {
            addPath(path.join(backupDir, name));
          }
        }
      } catch { /* unreadable backup folder — skip */ }
    }

    return results;
  });

  /**
   * search-ink-in-vellum — searches for a keyword in the handwriting of a single
   * .vellum file. For pages whose ink text is not yet cached, recognition is run
   * and the result written back into the ZIP so subsequent searches are instant.
   *
   * @param {string} vellumPath   — absolute path to the .vellum archive
   * @param {string} keyword      — search term (case-insensitive substring)
   * @returns {Promise<Array<{pageId:string, text:string}>>}
   *   One entry per matching page. text is the full recognised text for that page.
   */
  ipcMain.handle('search-ink-in-vellum', async (_event, vellumPath, keyword) => {
    if (!keyword || !vellumPath) return [];

    const needle = keyword.toLowerCase();

    let zip, annoJson;
    try {
      zip      = new AdmZip(vellumPath);
      const e  = zip.getEntry('annotations.json');
      annoJson = e ? JSON.parse(e.getData().toString('utf8')) : null;
    } catch {
      return [];
    }
    if (!annoJson) return [];

    // Group draw-stroke points by pageId
    const strokesByPage = {};
    for (const anno of (annoJson.annotations ?? [])) {
      if (anno.type !== 'draw' || !Array.isArray(anno.points) || anno.points.length < 2) continue;
      if (!strokesByPage[anno.pageId]) strokesByPage[anno.pageId] = [];
      strokesByPage[anno.pageId].push(anno.points.map(pt => ({ x: pt.x, y: pt.y })));
    }

    // Ensure cache maps exist
    if (!annoJson.pageInkText)     annoJson.pageInkText     = {};
    if (!annoJson.pageInkSegments) annoJson.pageInkSegments = {};

    let anyNewRecognition = false;

    // Recognise pages that don't have a cached result yet
    for (const [pageId, strokes] of Object.entries(strokesByPage)) {
      if (annoJson.pageInkText[pageId] !== undefined) continue; // already cached
      const { text, segments } = await _recognizePage(strokes);
      annoJson.pageInkText[pageId]     = text;
      annoJson.pageInkSegments[pageId] = segments;
      anyNewRecognition = true;
    }

    // Write updated annotations.json back into the ZIP if anything changed
    if (anyNewRecognition) {
      try {
        zip.deleteFile('annotations.json');
        zip.addFile('annotations.json', Buffer.from(JSON.stringify(annoJson, null, 2), 'utf8'));
        zip.writeZip(vellumPath);
      } catch { /* ZIP update failed — cached text still used this session */ }
    }

    // Return one entry per matching segment (not per page) so the UI can show
    // each occurrence as a separate result row with its own canvas highlight.
    const matches = [];
    for (const [pageId, segs] of Object.entries(annoJson.pageInkSegments)) {
      for (const seg of (segs ?? [])) {
        if (typeof seg.text === 'string' && seg.text.toLowerCase().includes(needle)) {
          matches.push({ pageId, text: seg.text, segments: [seg] });
        }
      }
    }
    return matches;
  });

  /**
   * backup-on-quit — synchronous IPC called by the renderer just before the
   * window closes (document switch or app quit). Creates a .vellum archive
   * of the current PDF + its annotations in the configured backup folder.
   *
   * Uses sendSync / ipcMain.on (not handle/invoke) so the renderer can block
   * until the backup write completes before the process exits.
   *
   * @param {string} pdfPath         — absolute path of the open PDF
   * @param {string} annotationsJson — serialised annotation JSON string (from memory)
   */
  ipcMain.on('backup-on-quit', (_event, pdfPath, annotationsJson) => {
    try {
      const backupDir = _loadSettings().backupDir;
      if (!backupDir || !pdfPath || !fs.existsSync(pdfPath)) return;

      const baseName   = path.basename(pdfPath, '.pdf');
      const timestamp  = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
      const vellumName = `${baseName}_${timestamp}.vellum`;

      // Remove any previous backup for this document so only the most recent
      // session is kept. Match files whose name starts with the same basename
      // followed by an underscore and the timestamp pattern.
      fs.mkdirSync(backupDir, { recursive: true });
      const prefix = `${baseName}_`;
      try {
        for (const name of fs.readdirSync(backupDir)) {
          if (name.startsWith(prefix) && name.toLowerCase().endsWith('.vellum')) {
            try { fs.unlinkSync(path.join(backupDir, name)); } catch { /* skip locked */ }
          }
        }
      } catch { /* folder unreadable — continue to write new backup */ }

      const zip = new AdmZip();
      zip.addLocalFile(pdfPath, '', 'document.pdf');
      // Use the in-memory JSON passed from the renderer — never read from disk
      // here, since the disk copy may be mid-write or corrupted.
      if (annotationsJson) {
        zip.addFile('annotations.json', Buffer.from(annotationsJson, 'utf8'));
      }

      const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
      const meta = JSON.stringify({
        title:        baseName,
        originalPath: pdfPath,
        createdAt:    new Date().toISOString(),
        appVersion:   packageJson.version,
      });
      zip.addFile('meta.json', Buffer.from(meta, 'utf8'));

      zip.writeZip(path.join(backupDir, vellumName));
    } catch (err) {
      // Backup failure must never block or crash the app
      console.error('backup-on-quit failed:', err);
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

/**
 * Returns a .pdf or .vellum file path passed via argv (e.g. when launched by
 * double-clicking a .vellum file in Explorer), or null if none was passed.
 * In dev (electron .) argv[1] is the script path, file arg starts at [2].
 * In the packaged app argv[0] is the exe, file arg starts at [1].
 */
function _getArgvFilePath(argv) {
  const args = (argv ?? process.argv).slice(app.isPackaged ? 1 : 2);
  const file = args.find(a => /\.(pdf|vellum)$/i.test(a) && !a.startsWith('--'));
  return file ?? null;
}

app.whenReady().then(() => {
  // Remove the default application menu — we have our own toolbar UI.
  // Must be called after app is ready; Menu is available from the start but
  // setApplicationMenu has no effect until the app is initialised.
  Menu.setApplicationMenu(null);

  // Intercept ms-gamingoverlay:// at the renderer level as well, in case
  // Chromium triggers it as an in-renderer navigation rather than a shell open.
  protocol.handle('ms-gamingoverlay', () => new Response(''));

  createWindow();

  // Initialise auto-updater after window exists so update-status events have a target.
  // Only active in packaged builds — dev mode has no update feed.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }

  // If the app was launched by opening a file (e.g. double-click in Explorer),
  // forward the path to the renderer once it has finished loading.
  const argvFile = _getArgvFilePath();
  if (argvFile) {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('open-file-argv', argvFile);
    });
  }

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
