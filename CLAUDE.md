# CLAUDE.md — Vellum

Single source of truth for this project. Read before starting any work.

---

## 0. Session Rules

**Auto-update rule:** At the end of every session (version bump or user says session is ending), Claude must update `## 9. Current Status` with the current date, phase, and notes. This rule must be preserved in every future version of this file.

**How to run:** `npm start` from a normal terminal (not VS Code integrated terminal). If PowerShell blocks it, run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` once. The launch script is `launch.js` which works around an `ELECTRON_RUN_AS_NODE` Electron quirk.

---

## 1. Project Identity

**Name:** Vellum  
**Purpose:** Personal desktop app for annotating PDFs and taking notes. Tablet-first, university use. May be shared with friends.  
**Design philosophy:** Minimalist, clean, focused. Every feature serves the core workflow.  
**Non-goals:** Cloud sync, collaboration, mobile support, PDF editing.  
**Tech:** Electron + PDF.js + vanilla JS. No build step. No framework.

---

## 2. Architecture

### Electron process model
- **Main process** (`main.js`): Node.js. File system, OS dialogs, IPC handlers.
- **Renderer process** (`src/`): Chromium. All UI and canvas logic.
- **Preload bridge** (`preload.js`): Exposes a safe `window.api` to the renderer. The only sanctioned renderer↔main channel.

### Infinite canvas coordinate system
Everything is in **canvas space** (world coordinates). The viewport transform converts to screen space:

```
screenX = canvasX * scale + panX
screenY = canvasY * scale + panY

canvasX = (screenX - panX) / scale
canvasY = (screenY - panY) / scale
```

**Annotations are stored in canvas coordinates, never screen coordinates.** This is the most important invariant in the codebase.

`viewport.js` owns `toScreen()` and `toCanvas()`. Never compute transforms inline — always call these.

### Tablet-first interaction model
The app is used on a tablet with a stylus. Keyboard is secondary.
- **Pen/mouse** → annotation tools
- **Touch** → pan only (never annotates)
- Every feature must be reachable via an on-screen tap target. Never keyboard-only.
- Touch targets: minimum 30×30px, ideally 36×44px.

### Rendering loop
Uses `requestAnimationFrame` with a `dirty` flag. Set the flag when state changes; the loop re-renders and clears it. Never render on every mouse event.

PDF pages are lazy-rendered — only pages near the viewport are rendered. Unloaded pages stay as sized placeholders.

---

## 3. Folder Structure

```
vellum/
├── main.js                      # Electron main process
├── preload.js                   # IPC bridge
├── launch.js                    # Wrapper to handle ELECTRON_RUN_AS_NODE
├── package.json
│
├── src/
│   ├── index.html
│   ├── style.css
│   ├── app.js                   # Top-level wiring
│   │
│   ├── canvas/
│   │   ├── viewport.js          # Pan, zoom, toScreen/toCanvas
│   │   ├── renderer.js          # Animation loop, draw registration
│   │   └── input.js             # Mouse/touch/pen input, palm rejection
│   │
│   ├── pdf/
│   │   ├── loader.js            # PDF.js init and PDF loading
│   │   ├── page.js              # PDFPage class — lazy render/unload
│   │   └── textSearch.js        # PDF text layer search
│   │
│   ├── pages/
│   │   ├── pageManager.js       # Layout: vertical + two-page side-by-side
│   │   └── blankPage.js         # Blank page creation
│   │
│   ├── annotations/
│   │   ├── manager.js           # In-memory annotation store + dirty tracking
│   │   ├── highlight.js         # Highlight tool (freehand path + shape snap)
│   │   ├── draw.js              # Freehand pen strokes (pressure-sensitive)
│   │   ├── note.js              # Text boxes / sticky notes
│   │   ├── image.js             # Image paste + crop
│   │   ├── shape.js             # Shape snap output
│   │   ├── eraser.js            # Partial/full eraser with size ring
│   │   └── select.js            # Lasso selection + move
│   │
│   ├── ui/
│   │   ├── toolbar.js           # Top toolbar (60px, 40×40 tool buttons)
│   │   ├── sidebar.js           # Left panel
│   │   ├── panel.js             # Right panel — page overview + thumbnails
│   │   ├── library.js           # File library (pinned folders + recent)
│   │   ├── floatingtoolbar.js   # Contextual floating toolbars
│   │   ├── search.js            # PDF text search UI
│   │   ├── screenshot.js        # Screenshot capture
│   │   └── shortcuts.js         # Keyboard shortcut registry
│   │
│   ├── storage/
│   │   ├── serialiser.js        # Annotation ↔ JSON conversion
│   │   └── autosave.js          # Debounced auto-save
│   │
│   └── export/
│       └── pdfExport.js         # PDF export — ink as vector, rest rasterised
│
└── assets/
    ├── icon.png
    └── icon.ico
```

---

## 4. Data Schema

Annotations file: `<filename>.annotations.json` in the same directory as the PDF.

```json
{
  "version": 1,
  "pdfPath": "/path/to/file.pdf",
  "pdfFingerprint": "sha256-of-first-8KB",
  "pageNotes": { "0": "notes text...", "1": "..." },
  "annotations": [ ...annotation objects... ]
}
```

### Annotation object

```json
{
  "id": "anno_<timestamp>_<random>",
  "type": "highlight | draw | stickyNote | textBox | image | shape",
  "pageIndex": 0,
  "canvasX": 142.5,
  "canvasY": 310.2,
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

### Per-type extra fields

| Type | Extra fields |
|------|-------------|
| `highlight` | `width`, `height`, `colour`, `points` |
| `draw` | `points: [{x,y,pressure}]`, `strokeWidth`, `colour` |
| `stickyNote` / `textBox` | `width`, `height`, `text`, `fontSize` |
| `image` | `width`, `height`, `imgW`, `imgH`, `cropX`, `cropY`, `dataUrl` |
| `shape` | `shapeType`, `width`, `height`, `colour`, `strokeWidth` |

### Image crop data model
- `canvasX/Y` = top-left of the **visible area** (shifts when cropping from top/left)
- `cropX/Y` = pixel offset into full image where visible window starts
- `width/height` = visible window; `imgW/imgH` = full image dimensions
- When uncropped: `imgW===width`, `imgH===height`, `cropX===0`, `cropY===0`

---

## 5. Design System

### Colour palette
```css
:root {
  --bg-app:        #0f0f0f;
  --bg-sidebar:    #141414;
  --bg-panel:      #1a1a1a;
  --bg-toolbar:    #141414;
  --bg-canvas:     #111111;

  --surface-1:     #1f1f1f;
  --surface-2:     #262626;
  --surface-3:     #2e2e2e;

  --border-subtle: #2a2a2a;
  --border-strong: #3a3a3a;

  --text-primary:  #f0f0f0;
  --text-secondary:#a0a0a0;
  --text-muted:    #5a5a5a;

  --accent:        #5b8af5;
  --accent-hover:  #7ba3ff;
  --accent-dim:    rgba(91, 138, 245, 0.15);

  --anno-yellow:   rgba(255, 213, 79, 0.35);
  --anno-green:    rgba(72, 199, 116, 0.35);
  --anno-pink:     rgba(255, 99, 132, 0.35);
  --anno-blue:     rgba(91, 138, 245, 0.35);

  --radius-sm:     4px;
  --radius-md:     8px;
  --radius-lg:     12px;
  --toolbar-height: 60px;
}
```

### Typography
```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
/* Scale: 11px / 12px / 13px / 14px / 16px */
```

### Interaction
- Hover: `var(--surface-2)` background, `150ms ease`
- Active/selected: `var(--accent-dim)` background + 2px `var(--accent)` left border
- Focus: 2px `var(--accent)` outline, 2px offset — never remove
- Shadows only on floating elements: `0 8px 24px rgba(0,0,0,0.4)`
- Spacing: multiples of 4px

---

## 6. Known Pitfalls

These have caused regressions before. Check here before touching these systems.

### PDFPage render/unload
- `mount()` must set `style.width` and `style.height` from `this.width`/`this.height`. If not set, pages appear as 30×15px squares before async render runs.
- `unload()`: use `canvas.width = 1; canvas.height = 1` — **never 0**. Zero dimensions invalidate the 2D context in Chromium, causing silent render failures on re-render.
- Do not attempt adaptive render scale. It causes silent failures at certain zoom levels. The unload/reload mechanism handles memory already.

### Image crop handles (pointer-events trap)
Select mode CSS hides all image handles with `pointer-events: none !important`. Without the `crop-mode` class override, clicking a crop handle fires on the image body and triggers a move instead:
```css
#canvas-container[data-tool="select"] .image-anno-handle.crop-mode {
  opacity: 1 !important;
  pointer-events: auto !important;
  z-index: 10 !important;
}
```

### Image `_applyImgStyle` must always run
In `updatePositions()`, call `_applyImgStyle(el, anno)` unconditionally every frame — no guard on whether width/height changed. `cropX/Y` can change without dimensions changing and any guard misses those updates.

### Two-page layout annotation positions
`_recomputeAndShift()` snapshots both X and Y positions of all pages before and after layout change and shifts all annotations by the delta. Both axes matter — skipping Y causes annotations to drift vertically.

---

## 7. Coding Standards

- No magic numbers — use named constants.
- No commented-out code — use git history.
- Functions do one thing.
- Early returns over nested conditionals.
- Comments only when the **why** is non-obvious — never explain what the code does.
- Every async operation in try/catch. Never swallow errors silently.
- Naming: `camelCase` vars, `UPPER_SNAKE_CASE` constants, `PascalCase` classes, `kebab-case.js` files.
- Never hard-code colours or sizes — always use CSS variables.

---

## 8. Backlog

### Next up
- [ ] Page reordering — drag in overview panel, call `movePage(from, to)`
- [ ] Window title with current filename — `document.title = filename + ' — Vellum'`

### Planned
- [ ] Presentation/focus mode — hide toolbar+panels, F11 or toolbar button
- [ ] Export page as PNG — right-click page in overview
- [ ] PDF text-layer highlight — PDF.js text layer + selection rects
- [ ] Zoom window — floating loupe at 3–4× for precise small writing

### Known bugs
- Escape key: modal closes but also deactivates current tool — fix is in `shortcuts.js:196` (comment says it shouldn't, but something else still fires it)
- `_mountAllPages()` must never be called while `pageInstances` has live entries — it creates duplicate DOM elements. Only call it after clearing all instances (e.g. on full load). When restoring a single page (undo), mount that page individually.

---

## 9. Shipping a Release

When Nico says "prepare for shipment" or "release", do the following in order:

1. **Bump version** in `package.json` (e.g. `1.4.1` → `1.4.2`)
2. **Build the installer:** `npm run build:win` — outputs `dist/Vellum-Setup.exe` and `dist/latest.yml`
3. **Create a GitHub release:**
   - Tag: `v{version}` (e.g. `v1.4.2`)
   - Title: `Vellum v{version}`
   - Upload both `dist/Vellum-Setup.exe` AND `dist/latest.yml` as release assets — **both files are required** for in-app auto-update to work
   - Write a short changelog in the release body
4. **Commit and tag:** `git add . && git commit -m "chore: bump version to {version}" && git tag v{version} && git push && git push --tags`

**Why `latest.yml` matters:** electron-updater downloads this file to check if an update is available and verify the installer hash. If it's missing from the release assets, in-app update silently fails.

**SmartScreen note:** The installer is unsigned. Users may see a SmartScreen warning on first install. This is expected and cannot be avoided without a code signing certificate. In-app updates after first install are smoother since the app is already running as trusted.

---

## 10. Current Status

**Last updated:** 2026-05-03  
**Version:** 1.4.6  
**State:** Stable. Unreleased changes pending (no version bump yet).  
**Pending release notes (to include in next version):**
- Removed handwriting search entirely — Windows Ink (Tablet PC API, 2003) was too inaccurate and too slow to be usable. Cached `pageInkText`/`pageInkSegments` in existing annotation files are silently ignored on load.
- Linux support groundwork: `fileAssociations` icon changed from `icon.ico` to `icon.png` so `npm run build:linux` produces a working AppImage on Ubuntu. Auto-update and file associations do not work on Linux (AppImage limitation) — manual install/update only. Build must be run on Linux (`npm install && npm run build:linux`), not cross-compiled from Windows.

**Notes:** v1.4.6: fixed PDF export — side-margin annotations now export beside their correct page (Y-proximity assignment at export time); textboxes now appear in export (type check was wrong); textbox word-wrap fixed in export (pixel-space drawing avoids measureText/scale mismatch); long unbroken words now split mid-character at box edge. v1.4.5: fixed annotations appearing shifted when switching between files with different page layout states — twoPageMode and pairedPages were global (localStorage), so enabling "pages together" on one file would reposition pages in every other file on load. Layout state is now saved per-file and restored before recomputeLayout() on load. v1.4.4: fixed textbox styles (colour, font size, alignment) not applying on file load — `applyBodyStyle` was called before the body element was appended to its container, so `querySelector` returned null and the style was silently skipped; also fixed `_focusedAnnoId` not being cleared when an annotation is removed (undo/×/empty-box), and flush pending text save on blur to prevent content loss on fast document switch. v1.4.3 shipped: fixed critical data-loss bug — autosave race condition wiped annotation file on document switch. v1.4.2: PDF page removal + undo, page reorder undo, two-page anchor fix, ghost-page bug fix, in-app auto-update (electron-updater), Lukas' Extra eraser mode, size picker UX improvements, preview dots/rings, min size 0.1. `latest.yml` must be uploaded to GitHub releases alongside the installer or updates silently fail.
