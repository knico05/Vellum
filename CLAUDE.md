# CLAUDE.md — PDF Annotator Project

> This file is the single source of truth for this project. Read it in full at the start of every session before writing any code. It explains not just *what* to build, but *why* every decision was made. When in doubt, refer back here.

---

## 0. How to Use This File

This is not a list of tasks to execute blindly. It is a thinking guide. Before writing any code for a task, pause and reason through:

- What problem does this task solve?
- What is the simplest correct solution?
- What could go wrong, and how do we guard against it?
- How does this connect to tasks that came before and after it?

After completing each task, reflect on what was built:
- Does it do exactly what was specified, no more, no less?
- Is it documented clearly enough for someone reading the file cold?
- Would a future version of this project need to change this code, and if so, have we made that easy?

Work at a pace that prioritises correctness and understanding over speed. If a task is ambiguous, state the ambiguity and propose the most reasonable interpretation before proceeding.

---

## 1. Project Identity

**Name:** PDF Annotator (working title, can be changed)  
**Owner:** Nico (solo developer)  
**Purpose:** A personal desktop app for annotating PDFs and taking notes, built primarily for university use. May be shared with a small circle of friends.  
**Design philosophy:** Minimalist, clean, and focused. Every feature serves the core workflow. Nothing exists just because it could.  
**Non-goals:** Cloud sync, collaboration, mobile support, PDF editing (as opposed to annotating).

---

## 2. Tech Stack & Rationale

Before touching any code, understand *why* each technology was chosen. Choosing the wrong tool at the start is expensive to undo.

### Electron
Electron bundles a Chromium browser engine with Node.js into a single desktop executable. This means we write one codebase in HTML/CSS/JS and it runs on Windows and Linux without modification. The trade-off is a larger binary size (~150MB), which is acceptable for a personal tool.

**Key mental model:** Electron has two distinct execution environments:
- **Main process** (`main.js`): Runs Node.js. Has access to the file system, OS dialogs, and system tray. Think of it as the backend.
- **Renderer process** (`src/`): Runs inside a Chromium window. Renders HTML/CSS/JS. Think of it as the frontend. Has no direct file system access by default (this is intentional for security).
- **IPC bridge** (`preload.js`): A controlled channel that lets the renderer ask the main process to do things (e.g. "read this file", "save this data"). This separation is not bureaucracy — it prevents malicious web content from accessing the user's filesystem.

### PDF.js (Mozilla)
PDF.js reads a PDF binary and renders each page onto an HTML `<canvas>` element. It does not rely on any OS-level PDF renderer, which means identical output on Windows and Linux.

**Key mental model:** A PDF file is a set of drawing instructions ("draw this glyph at this position, fill this rectangle with this colour"). PDF.js executes those instructions onto a canvas. Once rendered, the canvas is just pixels — PDF.js has methods to also extract the text layer separately, which we use for highlight-text-selection features later.

### Infinite Canvas
Rather than stacking PDF pages in a vertically scrolling container, the UI is built around an **infinite canvas** — a 2D plane that the user pans and zooms freely. PDF pages are placed as objects on this canvas. This is the same model used by Figma, Miro, and Excalidraw.

**Key mental model:** The canvas is a coordinate space that extends infinitely in all directions. We maintain a **viewport transform** — a combination of translation (pan offset) and scale (zoom level). Everything on the canvas is positioned in *canvas coordinates*. The viewport transform converts canvas coordinates to *screen coordinates* for rendering.

```
screenX = canvasX * scale + panOffsetX
screenY = canvasY * scale + panOffsetY
```

This means annotations must be stored in *canvas coordinates*, not screen coordinates. This is the most important architectural decision in the whole project. Get it right from the start.

### Vanilla JavaScript (no framework)
React/Vue/Angular add significant complexity for a project of this scope. We are not building a data-driven UI with hundreds of components — we are building a canvas-based tool. Vanilla JS keeps the codebase readable, debuggable, and fast without requiring knowledge of a framework's mental model.

### JSON file storage
Each PDF gets a companion `.annotations.json` file stored in the same directory. This is the simplest possible persistence mechanism: human-readable, easily backed up, easily inspected when debugging.

### Electron Builder
Packages the finished app into a native installer (`.exe` on Windows, `.AppImage` on Linux). Handles platform-specific packaging details so we don't have to.

---

## 3. Design System

The visual design should feel like a tool a designer would use — not a student project. The reference aesthetic is: **Linear, Raycast, Figma's UI chrome**. Dark mode by default. Clean typography. Intentional spacing. No decorative elements.

### Colour Palette

```css
:root {
  /* Backgrounds */
  --bg-app:        #0f0f0f;   /* Outermost app background */
  --bg-sidebar:    #141414;   /* Left sidebar */
  --bg-panel:      #1a1a1a;   /* Right notes panel */
  --bg-toolbar:    #141414;   /* Top toolbar */
  --bg-canvas:     #111111;   /* Infinite canvas background */

  /* Surface colours (for cards, dropdowns, modals) */
  --surface-1:     #1f1f1f;
  --surface-2:     #262626;
  --surface-3:     #2e2e2e;

  /* Borders */
  --border-subtle: #2a2a2a;
  --border-strong: #3a3a3a;

  /* Text */
  --text-primary:  #f0f0f0;
  --text-secondary:#a0a0a0;
  --text-muted:    #5a5a5a;

  /* Accent (used sparingly — active states, selections, highlights) */
  --accent:        #5b8af5;   /* Soft blue */
  --accent-hover:  #7ba3ff;
  --accent-dim:    rgba(91, 138, 245, 0.15);

  /* Annotation colours */
  --anno-yellow:   rgba(255, 213, 79, 0.35);
  --anno-green:    rgba(72, 199, 116, 0.35);
  --anno-pink:     rgba(255, 99, 132, 0.35);
  --anno-blue:     rgba(91, 138, 245, 0.35);

  /* Sizing */
  --radius-sm:     4px;
  --radius-md:     8px;
  --radius-lg:     12px;
  --sidebar-width: 240px;
  --toolbar-height: 44px;
  --panel-width:   300px;
}
```

### Typography

```css
/* Use system fonts — no web font dependency, instantly loads */
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;

/* Scale */
--text-xs:   11px;
--text-sm:   12px;
--text-base: 13px;
--text-md:   14px;
--text-lg:   16px;
```

### Spacing Principle
Use a base-8 spacing system. All margins, paddings, and gaps should be multiples of 4px (4, 8, 12, 16, 20, 24, 32, 48...). This creates visual rhythm without having to think about it on every element.

### Interaction Principles
- **Hover states** should be subtle — `var(--surface-2)` background, no border change.
- **Active/selected states** use `var(--accent-dim)` background + `var(--accent)` left border (2px).
- **Focus states** use a 2px `var(--accent)` outline with 2px offset. Never remove focus outlines.
- **Transitions** on interactive elements: `150ms ease` for hover, `100ms ease` for active. Nothing slower.
- **No shadows** except for floating elements (dropdowns, tooltips, modals): `0 8px 24px rgba(0,0,0,0.4)`.

---

## 4. App Layout

```
┌─────────────────────────────────────────────────────────────┐
│  TOOLBAR (44px)   [Open] [Tools] [Zoom] [─────────] [View]  │
├─────────────┬───────────────────────────────┬───────────────┤
│             │                               │               │
│   SIDEBAR   │       INFINITE CANVAS         │  NOTES PANEL  │
│   (240px)   │   (fills remaining space)     │   (300px)     │
│             │                               │               │
│ - Open PDFs │  [PDF page 1]                 │  Page notes   │
│ - File list │                               │  here         │
│ - Outline   │       [PDF page 2]            │               │
│             │                               │               │
│             │  [sticky note]                │               │
│             │                               │               │
└─────────────┴───────────────────────────────┴───────────────┘
```

The sidebar and notes panel are resizable by dragging their borders. Both can be collapsed to zero width. The canvas always fills the remaining space.

---

## 5. Folder Structure

Set this up exactly as specified before writing any application code. A clean structure prevents the project from becoming unmaintainable.

```
pdf-annotator/
├── main.js                  # Electron main process entry point
├── preload.js               # IPC bridge (exposes safe APIs to renderer)
├── package.json             # Dependencies and build config
├── package-lock.json        # Locked dependency tree (commit this)
├── .gitignore               # Node modules, build output, OS files
├── CLAUDE.md                # This file
├── CONCEPTS.md              # Your personal learning notes (fill as you go)
├── README.md                # Installation and usage guide
│
├── src/                     # Renderer process — all frontend code
│   ├── index.html           # App shell HTML
│   ├── style.css            # Global styles and CSS variables
│   │
│   ├── canvas/
│   │   ├── viewport.js      # Pan, zoom, coordinate transform logic
│   │   ├── renderer.js      # Draws everything onto the infinite canvas
│   │   └── input.js         # Mouse/touch/pen input handling on canvas
│   │
│   ├── pdf/
│   │   ├── loader.js        # PDF.js initialisation and PDF loading
│   │   └── page.js          # Individual page rendering and management
│   │
│   ├── annotations/
│   │   ├── manager.js       # In-memory annotation state
│   │   ├── highlight.js     # Highlight annotation tool
│   │   ├── draw.js          # Freehand draw tool
│   │   └── note.js          # Sticky note / text annotation tool
│   │
│   ├── ui/
│   │   ├── toolbar.js       # Top toolbar component
│   │   ├── sidebar.js       # Left sidebar component
│   │   ├── panel.js         # Right notes panel component
│   │   └── shortcuts.js     # Keyboard shortcut registry
│   │
│   └── storage/
│       ├── serialiser.js    # Convert annotation objects to/from JSON
│       └── autosave.js      # Debounced auto-save logic
│
└── assets/
    ├── icon.png             # App icon (512x512)
    └── icon.ico             # Windows icon
```

**Why this structure?** Each folder is a concern. `canvas/` owns the viewport and rendering. `pdf/` owns PDF.js integration. `annotations/` owns the tools. `ui/` owns the chrome. `storage/` owns persistence. No file should reach into another folder's concern without going through a well-defined interface.

---

## 6. Data Schema

Before writing any persistence code, nail down the data schema. Changing it later means migrating existing JSON files.

### Annotation Object

```json
{
  "id": "anno_1721234567890_abc123",
  "type": "highlight",
  "pageIndex": 0,
  "canvasX": 142.5,
  "canvasY": 310.2,
  "width": 280.0,
  "height": 18.0,
  "colour": "yellow",
  "createdAt": "2025-01-15T14:32:00Z",
  "updatedAt": "2025-01-15T14:32:00Z"
}
```

### Annotation Types

| Type | Additional Fields |
|------|-------------------|
| `highlight` | `width`, `height`, `colour` |
| `draw` | `points: [{x, y}]`, `strokeWidth`, `colour` |
| `stickyNote` | `width`, `height`, `text`, `colour` |
| `textBox` | `width`, `height`, `text`, `fontSize` |

### Full Annotation File

```json
{
  "version": 1,
  "pdfPath": "/Users/marco/uni/lecture3.pdf",
  "pdfFingerprint": "abc123...",
  "createdAt": "2025-01-15T14:00:00Z",
  "updatedAt": "2025-01-15T14:32:00Z",
  "pageNotes": {
    "0": "This page covers Gaussian elimination...",
    "1": "Important: see exercise 3.2"
  },
  "annotations": [
    { ...annotation object... },
    { ...annotation object... }
  ]
}
```

**Why `pdfFingerprint`?** PDFs can be renamed or moved. The fingerprint (a hash of the first N bytes of the PDF) lets us warn the user if the annotations file no longer matches the PDF. Prevents silently loading the wrong annotations.

**Why `version: 1`?** If the schema changes in a future version of the app, we can detect old files and migrate them. Without versioning, there is no safe upgrade path.

---

## 7. Build Plan

Each phase produces a working, testable application. Never start the next phase until the current one is tested and committed to Git.

The instruction for each task follows this pattern:

> **Think → Plan → Implement → Test → Document → Commit**

Do not skip the Think step. It prevents wasted work.

---

### Phase 1 — Project Scaffolding & Electron Shell

**Goal:** A running Electron window with the correct folder structure and design system in place. No PDF functionality yet.

**Why this first?** Getting the skeleton right before adding features prevents structural debt. A bad folder structure is painful to fix later. The design system being established now means every subsequent UI component inherits it automatically.

---

#### Task 1.1 — Initialise the Project

**Think:** What does `npm init` actually do? It creates `package.json`, which is the manifest for a Node.js project. It records the project name, version, and crucially, the list of dependencies. When someone clones the project and runs `npm install`, npm reads this file and installs everything. The `package-lock.json` it generates pins exact dependency versions — commit both files.

**Implementation:**

```bash
mkdir pdf-annotator
cd pdf-annotator
npm init -y
npm install --save-dev electron electron-builder
```

Set up `.gitignore`:

```
node_modules/
dist/
.DS_Store
Thumbs.db
*.log
```

Set up `package.json` scripts:

```json
{
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build:win": "electron-builder --win",
    "build:linux": "electron-builder --linux"
  }
}
```

**Test:** `npm start` should do nothing (crash) because `main.js` doesn't exist yet. That's expected — the test is that npm doesn't error on the script itself.

**Document:** Add a note to `CONCEPTS.md` explaining what `package.json` is and why `node_modules` is gitignored.

---

#### Task 1.2 — Main Process (`main.js`)

**Think:** The main process is the first thing Electron runs when the app starts. Its job here is narrow: create a window, load our HTML, and set up security. We are not putting any business logic here in Phase 1.

The `BrowserWindow` API creates OS-level windows. We configure it with:
- `webPreferences.contextIsolation: true` — isolates the renderer from Node.js globals (security best practice)
- `webPreferences.preload` — points to our bridge script
- `nodeIntegration: false` — renderer cannot directly use Node.js (forces everything through IPC)

**Implementation:** Create `main.js` with:
- App ready handler that creates the window
- Window configuration: frameless or standard frame (decide: frameless looks cleaner but requires custom title bar — recommend frameless with custom chrome)
- Load `src/index.html`
- Handle `window-all-closed` to quit the app

**Test:** `npm start` opens a blank window.

**Document:** Comment every option in `webPreferences` explaining why it's set that way.

---

#### Task 1.3 — Preload Bridge (`preload.js`)

**Think:** The preload script runs in a special context — it has access to Node.js APIs AND the renderer's `window` object, but they are isolated from each other. It uses `contextBridge.exposeInMainWorld` to expose a safe, limited API to the renderer. This is the only sanctioned way for the renderer to communicate with the main process.

Think of `preload.js` as a border control officer: it decides exactly what the renderer is allowed to request, and nothing more.

**Implementation:** Create `preload.js` exposing a `window.api` object with:
- `openFile()` — triggers native file open dialog, returns file path
- `readFile(path)` — reads a file, returns Buffer
- `writeFile(path, data)` — writes a file
- `onMenuAction(callback)` — receives menu commands from main process

**Test:** Open DevTools in the Electron window (`Ctrl+Shift+I`). In the console, type `window.api`. It should show the exposed object.

**Document:** In `preload.js`, add a header comment explaining the security model and why each exposed function exists.

---

#### Task 1.4 — App Shell HTML + Design System CSS

**Think:** `index.html` is the skeleton. It defines the DOM structure that all subsequent JavaScript will operate on. We are not adding logic here — only structure. Structure should be stable; logic will change. Keep them separate.

The CSS file establishes the design system from Section 3 of this document. Every subsequent UI component will use these variables. Do not hard-code any colour or size value in component-level CSS — always reference a variable.

**Implementation:**

`src/index.html` — Define:
- `#app` — root container
- `#toolbar` — top bar (44px)
- `#sidebar` — left panel (240px)
- `#canvas-container` — fills remaining space
- `#notes-panel` — right panel (300px)

`src/style.css` — Implement the full design system from Section 3:
- All CSS custom properties
- Reset styles (box-sizing, margin, padding)
- Base typography
- Layout rules (CSS Grid for the main layout)
- Scrollbar styling (`-webkit-scrollbar` for a thin, dark scrollbar)

**Test:** The app opens showing the correct dark background with layout regions visible (add temporary coloured borders to verify structure, remove before committing).

**Commit message:** `feat: scaffold project with Electron shell and design system`

---

### Phase 2 — Infinite Canvas Viewport

**Goal:** A pannable, zoomable infinite canvas. No PDF yet. Just the canvas mechanics working correctly.

**Why before PDF?** The infinite canvas is the foundation everything else sits on. Getting the coordinate maths right before adding PDF rendering prevents a painful refactor later. Test the canvas in isolation.

---

#### Task 2.1 — Understand the Viewport Transform

**Think — read this carefully before writing any code:**

The infinite canvas uses a 2D affine transformation to map between two coordinate spaces:

1. **Canvas space** (also called world space): The abstract coordinates where we place objects. A PDF page might be at canvas position (0, 0). Annotations are stored in canvas space.

2. **Screen space**: Pixel coordinates on the user's monitor. What actually gets rendered.

The transform is: `screenPos = canvasPos * scale + pan`

Where:
- `scale` is the current zoom level (1.0 = 100%, 2.0 = 200%, etc.)
- `pan` is a `{x, y}` offset representing how far the viewport has been dragged

We also need the inverse for hit testing (when the user clicks at screen position (400, 300), what canvas coordinate is that?):

`canvasPos = (screenPos - pan) / scale`

These two functions are the most important functions in the whole codebase. Implement them once in `viewport.js` and use them everywhere. Never calculate coordinate transforms inline.

**Implementation:** Create `src/canvas/viewport.js` with:
- `state` object: `{ scale: 1.0, panX: 0, panY: 0, minScale: 0.1, maxScale: 5.0 }`
- `toScreen(canvasX, canvasY)` → `{x, y}` in screen space
- `toCanvas(screenX, screenY)` → `{x, y}` in canvas space
- `zoom(delta, originX, originY)` — zooms toward a point (critical: zoom should happen toward the mouse cursor, not the top-left corner)
- `pan(dx, dy)` — translates the viewport

**Test:** Write a test in the browser console: set pan to (100, 100) and scale to 2.0. Call `toScreen(0, 0)` — it should return `{x: 100, y: 100}`. Call `toCanvas(100, 100)` — it should return `{x: 0, y: 0}`. These are your unit tests.

---

#### Task 2.2 — Canvas Rendering Loop

**Think:** The canvas renders using `requestAnimationFrame` — a browser API that calls our draw function at the monitor's refresh rate (typically 60fps or 120fps). This is the standard approach for real-time graphics. We don't render on every mouse event (too slow) — we flag that a re-render is needed and let the animation loop handle it.

The render loop:
1. Clear the canvas
2. Apply the current viewport transform (pan + scale)
3. Draw everything in canvas space
4. `requestAnimationFrame` schedules the next frame

We use a `dirty` flag: set to `true` whenever state changes. The loop only re-renders when `dirty` is true, then clears the flag. This prevents wasting CPU on frames where nothing changed.

**Implementation:** Create `src/canvas/renderer.js` with:
- A `<canvas>` element that fills `#canvas-container` (listen to resize events)
- `start()` — begins the animation loop
- `requestRender()` — sets the dirty flag
- `render()` — clears, applies transform, draws a subtle dot-grid background (visual indicator that it's an infinite canvas), then draws all registered objects
- `register(drawFn)` — lets other modules add things to be drawn each frame

Draw the background: a grid of small dots (`radius: 1px`, colour: `var(--border-subtle)`, spaced 24px apart in canvas space). The dots should move with the pan/zoom to reinforce the infinite canvas feeling.

**Test:** The canvas shows a dot grid. Panning and zooming (next task) should move the grid correctly.

---

#### Task 2.3 — Pan and Zoom Input

**Think:** We handle three input methods for pan/zoom:
- **Mouse drag** (middle mouse button, or space + left drag): Pan
- **Mouse wheel**: Zoom toward cursor (or pan if shift is held)
- **Trackpad pinch**: Zoom (this comes through as `wheel` events with `ctrlKey: true` on most systems)
- **Keyboard**: `+`/`-` to zoom, arrow keys to pan

For zoom, the critical detail is *zoom toward the cursor*. If the user's cursor is over a specific word in a PDF, zooming should keep that word under the cursor. The maths: before zooming, record the canvas position under the cursor. After zooming, adjust pan so that same canvas position is again under the cursor.

```javascript
// Zoom toward point (screenX, screenY)
const beforeZoom = viewport.toCanvas(screenX, screenY);
viewport.state.scale *= zoomFactor;
viewport.state.scale = clamp(viewport.state.scale, minScale, maxScale);
const afterZoom = viewport.toCanvas(screenX, screenY);
viewport.state.panX += (afterZoom.x - beforeZoom.x) * viewport.state.scale;
viewport.state.panY += (afterZoom.y - beforeZoom.y) * viewport.state.scale;
```

Wait — reflect on this. The pan offset is in screen space but the delta is in canvas space. Re-examine this calculation carefully and make sure the units are consistent before implementing.

**Implementation:** Create `src/canvas/input.js` with:
- Event listeners on `#canvas-container` for `mousedown`, `mousemove`, `mouseup`, `wheel`
- Space bar held = pan mode cursor (`cursor: grab`)
- Smooth pan via mouse drag
- Zoom via scroll wheel, zoom toward cursor
- Dispatch a `viewport-changed` custom event after each pan/zoom (other modules listen to this)

**Test:** Open the app. The dot grid should pan smoothly when dragging with space held. Scrolling should zoom toward the cursor position. Verify: zoom in on the top-right area of the canvas. The top-right area should stay in view, not the centre.

**Commit message:** `feat: implement infinite canvas with pan/zoom viewport`

---

### Phase 3 — PDF Rendering on Canvas

**Goal:** Load a PDF and render its pages as objects on the infinite canvas. Pages should pan and zoom with the canvas.

---

#### Task 3.1 — Install and Configure PDF.js

**Think:** PDF.js is a large library. We install it via npm but use its pre-built distributable. It needs a Web Worker to do PDF parsing off the main thread (so the UI doesn't freeze while loading large PDFs). The worker path must be configured explicitly.

**Implementation:**

```bash
npm install pdfjs-dist
```

Create `src/pdf/loader.js`:
- Import PDF.js and set `GlobalWorkerOptions.workerSrc`
- Export `loadPDF(arrayBuffer)` → returns a PDF document object
- Export `getPage(pdfDoc, pageIndex)` → returns a page object with dimensions

**Test:** In the browser console, load a small PDF manually. Call `loadPDF`. Log the number of pages. Confirm it returns the correct count without errors.

---

#### Task 3.2 — Page Rendering

**Think:** Each PDF page renders to its own `<canvas>` element via PDF.js's `page.render()` method. These canvases are then positioned as DOM elements inside `#canvas-container`, transformed according to the viewport state.

We do NOT render all pages at once. We implement **lazy rendering** — only render pages within or near the current viewport. For a 200-page PDF, rendering all pages upfront would use gigabytes of memory.

Viewport culling: a page is in the viewport if its canvas-space bounding box intersects the screen. Check this before rendering each page.

**Implementation:** Create `src/pdf/page.js` with:
- `PDFPage` class with: `pageIndex`, `canvasX`, `canvasY`, `width`, `height`, `rendered` flag
- `render(viewport)` — renders the page at the current scale if in viewport and not yet rendered
- `isInViewport(viewport)` — returns bool (bounding box intersection check)
- Pages are laid out vertically in canvas space starting at (0, 0), with 24px gap between pages

**Test:** Open a multi-page PDF. Scroll through it. Check memory usage (DevTools → Memory). Pages far out of view should not be consuming memory.

---

#### Task 3.3 — File Open Flow

**Think:** The user triggers a file open. This travels through several layers:
1. User clicks "Open" button in toolbar
2. Renderer calls `window.api.openFile()` (preload bridge)
3. Main process shows native OS file dialog
4. User selects a PDF
5. Main process reads the file into a Buffer
6. Buffer returned to renderer via IPC
7. Renderer passes ArrayBuffer to PDF.js
8. PDF.js loads and returns document
9. Pages are laid out on the canvas
10. Check for companion `.annotations.json` file and load if exists

Trace this flow before implementing it. Knowing the full path prevents bugs.

**Implementation:** Wire up the toolbar's open button. On file select, clear the canvas, load the PDF, position pages in canvas space, centre the viewport on the first page.

**Test:** Open a real lecture PDF. All pages visible. Pan/zoom works. Opening a second PDF replaces the first cleanly.

**Commit message:** `feat: render PDF pages on infinite canvas with lazy loading`

---

### Phase 4 — Annotation Tools

**Goal:** Highlight, draw, and sticky note tools, all stored in canvas coordinates.

**Why this ordering within the phase?** Highlight is the most-used tool and validates the coordinate system. Draw validates pointer events. Sticky notes validate the DOM-overlay approach for interactive elements.

---

#### Task 4.1 — Annotation Manager

**Think:** The annotation manager is the single source of truth for all annotations in memory. It is not a UI component — it has no knowledge of the DOM. It is a pure data store with methods to add, remove, and query annotations.

This separation matters: the renderer asks the manager "give me all annotations for page 2" and draws them. The tools tell the manager "add this annotation". The storage module asks the manager "give me everything serialisable". No circular dependencies.

**Implementation:** Create `src/annotations/manager.js` with:
- `annotations` array (in-memory state)
- `add(annotation)` → generates ID, timestamps, pushes to array, emits `annotations-changed` event
- `remove(id)` → filters out by ID, emits `annotations-changed` event
- `getByPage(pageIndex)` → filters by page
- `getAll()` → returns full array
- `loadFromJSON(data)` → replaces state from parsed JSON
- `toJSON()` → returns serialisable snapshot

**Test:** In the console: `annotationManager.add({type:'highlight', pageIndex:0, ...})`. Then `annotationManager.getByPage(0)` — should return the added annotation. Then `annotationManager.remove(id)` and verify it's gone.

---

#### Task 4.2 — Highlight Tool

**Think:** The highlight tool works in two stages:
1. **Mouse down**: Record the start point (in canvas coordinates)
2. **Mouse drag**: Draw a live preview rectangle (in screen space, for performance)
3. **Mouse up**: Convert start and end to canvas coordinates, create annotation, clear preview

The live preview should be drawn directly on a `<canvas>` overlay (not via the annotation manager) so it doesn't trigger a save on every mouse move.

**Implementation:** Create `src/annotations/highlight.js` with:
- `activate()` / `deactivate()` — enable/disable the tool
- Mouse event handlers on the canvas overlay
- Convert final rect to canvas coordinates using `viewport.toCanvas()`
- Create annotation object matching the schema from Section 6
- Add to annotation manager

The renderer should draw highlights as semi-transparent filled rectangles. Colour comes from `--anno-*` CSS variables — but since we're drawing on canvas (not DOM), read the computed CSS variable value once and cache it.

**Test:** Activate highlight tool. Drag over a word in the PDF. Release. The highlight should appear. Zoom in — the highlight should scale correctly with the PDF. Zoom out — same.

---

#### Task 4.3 — Freehand Draw Tool

**Think:** The draw tool records a sequence of `{x, y}` points in canvas coordinates as the user drags. We don't store every mouse position — we simplify the path using the **Ramer-Douglas-Peucker algorithm** (or a simple distance threshold: only add a point if it's more than 2px from the last point in canvas space). This keeps the stored path small.

For rendering, we draw the path using `ctx.lineTo()` for performance. For the live preview during drawing, we draw on a separate overlay canvas.

**Think about stylus input:** The Pointer Events API gives us `pressure` for pen input (0.0 to 1.0). We should use this to vary stroke width if a stylus is detected (`event.pointerType === 'pen'`). This is a small detail that makes the app feel considerate.

**Implementation:** Create `src/annotations/draw.js` with path recording, simplification, and pressure-sensitive stroke width. When mouse/pen releases, finalise path into annotation object.

---

#### Task 4.4 — Sticky Notes

**Think:** Sticky notes are different from highlights and draw annotations. They are interactive DOM elements, not just drawn pixels. A sticky note needs to be:
- Positioned on the canvas (transforms with viewport)
- Editable (click to edit text)
- Draggable (move to a new position on the canvas)
- Resizable

We implement sticky notes as `<div>` elements absolutely positioned inside `#canvas-container`. Their `left` and `top` CSS properties are updated every frame by the renderer, converting their canvas position to screen position.

This is the **DOM overlay approach**: the canvas renders the static background, while interactive elements are DOM nodes positioned on top.

**Implementation:** Create `src/annotations/note.js` with:
- `createNoteElement(annotation)` — creates a styled `<div>` with `contenteditable` text area
- `positionElement(el, annotation, viewport)` — updates position/size based on current viewport transform
- Drag to reposition: update annotation's canvas coordinates in the manager
- Text changes trigger debounced save

**Test:** Double-click anywhere on the canvas to create a sticky note. Type text. Pan/zoom — the note should move with the canvas. Drag the note to a new position. Close and reopen — note should be in the correct position.

**Commit message:** `feat: implement highlight, draw, and sticky note annotation tools`

---

### Phase 5 — Persistence

**Goal:** Annotations survive app restarts. Auto-save is seamless and unobtrusive.

---

#### Task 5.1 — Serialisation

**Think:** Serialisation is converting in-memory objects into a format that can be written to disk and read back. JSON is our format. The serialiser should be a pure module: given annotations, produce JSON. Given JSON, produce annotations. No side effects, no I/O.

**Implementation:** Create `src/storage/serialiser.js` with:
- `serialise(pdfPath, pdfFingerprint, annotations, pageNotes)` → JSON string
- `deserialise(jsonString)` → `{annotations, pageNotes, version}` 
- Version checking: if `data.version !== CURRENT_VERSION`, log a warning and attempt graceful migration

---

#### Task 5.2 — Auto-Save

**Think:** We do not save on every annotation change — that would cause excessive disk writes (especially during freehand drawing where we get hundreds of events per second). Instead we use **debouncing**: wait until N milliseconds have passed with no changes, then save.

Debounce with 1000ms (1 second) delay. The user will never notice the delay, and we reduce disk writes by orders of magnitude.

**Implementation:** Create `src/storage/autosave.js` with:
- `init(getStateCallback, savePath)` — sets up the auto-save system
- `schedulesSave()` — debounced save trigger
- Calls `window.api.writeFile(path, data)` via the IPC bridge
- On save: briefly show a "Saved" indicator in the toolbar (fade in, hold 1s, fade out)

---

#### Task 5.3 — Load on Open

**Think:** When the user opens `lecture3.pdf`, check if `lecture3.annotations.json` exists in the same directory. If it does:
1. Read and parse it
2. Verify the fingerprint matches the current PDF (warn if not)
3. Load annotations into the manager
4. Re-render

The fingerprint check prevents silently loading wrong annotations if the user has multiple PDFs with the same filename in different folders.

**Implementation:** Wire this into the file open flow from Task 3.3. Fingerprint: MD5 or SHA-256 of the first 8KB of the PDF. Use Node's built-in `crypto` module in the main process.

**Test:** Open a PDF, add several annotations. Close the app. Reopen the app and open the same PDF. All annotations should be exactly where you left them.

**Commit message:** `feat: implement auto-save and annotation persistence`

---

### Phase 6 — Notes Panel & Polish

**Goal:** Right-side notes panel, keyboard shortcuts, and UI refinements.

---

#### Task 6.1 — Notes Panel

**Think:** The notes panel is a per-page text editor. When the user navigates to a different page, the panel shows notes for that page. Notes are stored in the same `.annotations.json` file under `pageNotes[pageIndex]`.

For the editor itself: use `contenteditable` with a minimal toolbar (bold, italic, bullet list). Do not use a third-party rich text editor — they are heavy and opinionated. Vanilla `document.execCommand` (deprecated but still functional in Electron's Chromium) or manual DOM manipulation is sufficient for these three formatting options.

**Implementation:** Create `src/ui/panel.js` with:
- Panel shows/hides based on a toggle
- Current page detection: which page occupies the most screen space in the current viewport?
- `loadPageNotes(pageIndex)` — populates the editor
- `savePageNotes(pageIndex, content)` — writes to annotation manager, triggers auto-save

---

#### Task 6.2 — Keyboard Shortcuts

**Think:** Power users avoid the mouse for tool switching. Keyboard shortcuts should be discoverable (shown in tooltips) and follow conventions.

| Shortcut | Action |
|---|---|
| `V` | Cursor/select tool |
| `H` | Highlight tool |
| `D` | Draw tool |
| `N` | Sticky note tool |
| `E` | Eraser |
| `Ctrl+O` | Open file |
| `Ctrl+Z` | Undo last annotation |
| `Space + drag` | Pan |
| `Ctrl+0` | Reset zoom to 100% |
| `Ctrl+Shift+F` | Fit page to window |
| `[` / `]` | Previous / next page |
| `Escape` | Deselect / cancel current action |

**Implementation:** Create `src/ui/shortcuts.js` as a central shortcut registry. Each shortcut is `{key, modifiers, action, description}`. The registry also powers the keyboard shortcut reference modal (press `?` to show).

---

#### Task 6.3 — Toolbar

**Think:** The toolbar communicates the current state clearly: which tool is active, current zoom level, current page. It should never require the user to hunt for information.

Layout (left to right):
- App icon / menu (3 dots)
- `[Open]` button
- Separator
- Tool buttons: cursor, highlight, draw, note, eraser — with active state
- Separator
- Colour picker (visible only when highlight or draw is active)
- Right-aligned: page indicator (`3 / 24`), zoom level (`127%`), fit-page button, sidebar toggle, panel toggle

Implement tool buttons as a group where exactly one is always active (radio button semantics). Use `data-tool` attributes and CSS to handle active states without JavaScript style manipulation.

---

#### Task 6.4 — Undo

**Think:** Undo is a **command stack**. Every action that modifies state (add annotation, remove annotation, move sticky note) is recorded as a command object with an `execute()` and `undo()` method. Ctrl+Z pops the last command and calls `undo()`.

Keep it simple: only support annotation add/remove/move for now. Do not implement undo for notes text — that's handled by the browser's native contenteditable undo.

**Implementation:** A simple array stack. Max 50 items. When a new command is executed, push it. When undone, pop and call `.undo()`. Clear the stack when a new PDF is opened.

**Commit message:** `feat: notes panel, keyboard shortcuts, toolbar, undo system`

---

### Phase 7 — Distribution

**Goal:** An installable `.exe` for Windows and `.AppImage` for Linux that Marco's friends can run.

---

#### Task 7.1 — Electron Builder Config

**Think:** Electron Builder reads configuration from `package.json` under the `"build"` key. It needs:
- App ID (reverse domain notation: `com.marco.pdf-annotator`)
- Product name
- Directories: where the source is, where to output built files
- Target configurations per platform

**Implementation:** Add build config to `package.json`:
```json
{
  "build": {
    "appId": "com.marco.pdf-annotator",
    "productName": "PDF Annotator",
    "directories": { "output": "dist" },
    "win": { "target": "nsis", "icon": "assets/icon.ico" },
    "linux": { "target": "AppImage", "icon": "assets/icon.png" }
  }
}
```

---

#### Task 7.2 — App Icon

**Think:** The icon is the first thing users see before opening the app. A clean, simple icon reflects the quality of the app. Minimum: a stylised PDF page with an annotation mark. Create it in a vector tool or commission a 512x512 PNG.

For Windows, convert PNG to `.ico` format (multi-resolution). Use the `png-to-ico` npm package or an online converter.

---

#### Task 7.3 — Build and Test

Run `npm run build:win` on Windows and `npm run build:linux` on Linux (or WSL). Test the installer on a clean user account (no Node.js installed). Verify:
- App installs without errors
- PDF opens correctly
- Annotations save and load
- App uninstalls cleanly (Windows: check Add/Remove Programs)

**Commit message:** `feat: configure Electron Builder for Windows and Linux distribution`

---

## 8. Coding Standards

These rules apply to every file in the project. Enforce them from day one.

### General
- No magic numbers. Every literal value that is not `0` or `1` should be a named constant.
- No commented-out code. Use Git history if you need to recover deleted code.
- Functions should do one thing. If you find yourself writing "and" in a function name, split it.
- Early returns over nested conditionals. Prefer `if (error) return;` over `if (success) { ... }`.

### Comments
- File header: purpose, imports, exports, design notes.
- Function: what it does, parameters with types, return value, side effects.
- Inline comment: explain *why*, not *what*. The code already says what — comments explain the reasoning.

### Error Handling
- Every async operation is wrapped in try/catch.
- Every catch block either recovers gracefully or shows the user a clear error message.
- Never silently swallow errors (`catch(e) {}`).

### Naming
- Variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Classes: `PascalCase`
- Files: `kebab-case.js`
- Prefer long, clear names over short cryptic ones. `annotationCanvasX` over `acx`.

---

## 9. CONCEPTS.md Template

Create `CONCEPTS.md` and add an entry every time you encounter something new. Minimum entries expected:

```markdown
# Concepts Learned

## Electron Process Model
[Explain in your own words: what main process does, what renderer does, why IPC exists]

## Coordinate Spaces
[Explain canvas space vs screen space. Write out the transform formula.]

## The Viewport Transform
[Explain how pan and zoom combine. Why zoom toward cursor requires adjusting pan.]

## Infinite Canvas Pattern
[Explain the dot grid, the dirty flag, requestAnimationFrame.]

## JSON Serialisation
[Explain what serialisation is, what the annotation schema contains, why versioning matters.]

## PDF.js Architecture
[Explain the worker thread, why canvas is used, what lazy rendering means.]

## Lazy Rendering
[Explain viewport culling — how we decide which pages to render.]

## Debouncing
[Explain why we debounce auto-save, what debounce means, how it's implemented.]

## The Command Pattern (Undo)
[Explain execute/undo, the command stack, why max 50 items.]
```

---

## 10. Git Workflow

Commit after every completed task. Never let uncommitted changes accumulate overnight.

Commit message format:
```
type: short description

Optional longer explanation if needed.
```

Types: `feat` (new feature), `fix` (bug fix), `docs` (documentation), `style` (CSS/visual), `refactor` (restructuring without behaviour change), `test` (adding tests), `chore` (build config, dependencies).

Create a tag at the end of each phase: `git tag phase-1-complete`.

---

## 11. Session Checklist

Run through this at the start and end of every coding session:

**Start of session:**
- [ ] Re-read this file's section for today's phase
- [ ] Run `npm start` — app should open without errors
- [ ] Note which task you are starting

**End of session:**
- [ ] All written code has comments
- [ ] `CONCEPTS.md` updated with anything new
- [ ] Changes committed with a meaningful message
- [ ] Phase tag created if phase is complete
- [ ] Brief note of where to pick up next session (add to this file under a `## Current Status` heading)

---

## 12. Current Status

> Update this section at the end of every session.

**Last updated:** 2026-03-25
**Current phase:** Phase 2 complete — starting Phase 3 next session
**Next task:** Task 3.1 — Install and configure PDF.js
**Notes:** Phases 1 and 2 are fully committed and tagged (phase-1-complete, phase-2-complete). App runs via `npm start` from a normal terminal (not VS Code integrated terminal — run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` in PowerShell first if not done). Touch/stylus pan and pinch-zoom are implemented. ELECTRON_RUN_AS_NODE quirk is handled by launch.js.
