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
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const AdmZip = require('adm-zip');

// ---------------------------------------------------------------------------
// Update check config — fill in YOUR GitHub username/repo before publishing
// ---------------------------------------------------------------------------

/**
 * The GitHub repo to check for new releases.
 * Format: 'username/repo-name'
 * Tag format expected: 'v1.2.3'
 */
const GITHUB_REPO = 'knico05/Vellum';

/**
 * Returns true if `latest` is a strictly newer semver than `current`.
 * Both strings should be in 'major.minor.patch' format (no 'v' prefix).
 *
 * @param {string} latest
 * @param {string} current
 * @returns {boolean}
 */
function _isNewerVersion(latest, current) {
  if (!latest || !current) return false;
  const parse = v => v.split('.').map(n => parseInt(n, 10) || 0);
  const [lMaj, lMin, lPatch] = parse(latest);
  const [cMaj, cMin, cPatch] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPatch > cPatch;
}

// Prevent Windows Xbox Game Bar from injecting its overlay into the Electron
// window. Without this, Chromium registers as a "game" and Windows pops up an
// "ms-gamingoverlay" dialog every time the app launches.
app.commandLine.appendSwitch('disable-features', 'GameOverlayEmbeddedBrowser,HardwareMediaKeyHandling,MediaSessionService');

// Chromium fires an ms-gamingoverlay:// protocol call on startup when it
// detects a game-like environment. If nothing is registered to handle that
// protocol, Windows shows a "Get an app to open this link" dialog pointing to
// the Microsoft Store. Register ourselves as the silent handler so Windows
// routes the call back to us without showing any dialog.
app.setAsDefaultProtocolClient('ms-gamingoverlay');

// Set the App User Model ID so Windows recognises this as a known app rather
// than an unknown process, which prevents it from prompting the Microsoft Store
// to find a handler for various Windows protocols.
app.setAppUserModelId('com.vellum.app');

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
    'trailer<</Size 4/Root 1 0 R>>\n',
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

  /**
   * check-for-updates — fetches the latest GitHub release and compares it
   * against the current app version.
   *
   * Returns:
   *   { currentVersion, latestVersion, releaseUrl, hasUpdate }
   *
   * On network error or timeout, resolves with hasUpdate: false so the app
   * starts cleanly even when offline.
   */
  ipcMain.handle('check-for-updates', () => {
    const currentVersion = app.getVersion();

    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path:     `/repos/${GITHUB_REPO}/releases/latest`,
        headers:  { 'User-Agent': 'PDF-Annotator-UpdateCheck' },
      };

      const req = https.get(options, (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try {
            const release      = JSON.parse(raw);
            const tag          = release.tag_name  ?? '';
            const latestVersion = tag.replace(/^v/, '');
            const releaseUrl   = release.html_url  ?? '';
            const hasUpdate    = _isNewerVersion(latestVersion, currentVersion);
            resolve({ currentVersion, latestVersion, releaseUrl, hasUpdate });
          } catch {
            resolve({ currentVersion, latestVersion: null, releaseUrl: null, hasUpdate: false });
          }
        });
      });

      // Network error (offline, DNS fail, etc.) — fail gracefully
      req.on('error', () => {
        resolve({ currentVersion, latestVersion: null, releaseUrl: null, hasUpdate: false });
      });

      // 8-second timeout — avoids hanging on a slow connection at startup
      req.setTimeout(8000, () => {
        req.destroy();
        resolve({ currentVersion, latestVersion: null, releaseUrl: null, hasUpdate: false });
      });
    });
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
   * backup-on-quit — synchronous IPC called by the renderer just before the
   * window closes (document switch or app quit). Creates a .vellum archive
   * of the current PDF + its annotations in the configured backup folder.
   *
   * Uses sendSync / ipcMain.on (not handle/invoke) so the renderer can block
   * until the backup write completes before the process exits.
   *
   * @param {string} pdfPath             — absolute path of the open PDF
   * @param {string} annotationsJsonPath — absolute path of the annotation JSON
   */
  ipcMain.on('backup-on-quit', (_event, pdfPath, annotationsJsonPath) => {
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
function _getArgvFilePath() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
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
