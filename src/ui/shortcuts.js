/**
 * shortcuts.js — Centralised keyboard shortcut registry
 *
 * Handles all global keyboard shortcuts except those that are tightly coupled
 * to a single module (e.g. space+drag for pan is handled in input.js because
 * it needs pointer event context).
 *
 * Shortcuts that fire while the user is typing in an editable element are
 * suppressed (except Ctrl+O and Ctrl+Z which are safe to allow).
 *
 * The shortcut help modal (press ?) is created and injected into the DOM
 * by this module. It lists all registered shortcuts in a clean two-column grid.
 *
 * Exports: init(callbacks)
 */

'use strict';

// ---------------------------------------------------------------------------
// Shortcut definitions
// ---------------------------------------------------------------------------

/**
 * Static list of shortcuts for the help modal display.
 * These are documentation only — actual handlers are registered separately.
 *
 * @type {Array<{ key: string, description: string }>}
 */
const SHORTCUT_DOCS = [
  { key: 'V',           description: 'Cursor / select tool'   },
  { key: 'H',           description: 'Highlight tool'          },
  { key: 'D',           description: 'Draw tool'               },
  { key: 'N',           description: 'Sticky note tool'        },
  { key: 'S',           description: 'Select & move tool'      },
  { key: 'E',           description: 'Eraser tool'             },
  { key: '[ / ]',       description: 'Previous / next page'    },
  { key: 'F',           description: 'Fit page to window'      },
  { key: 'P',           description: 'Toggle pages panel'      },
  { key: 'Escape',      description: 'Deselect / cancel'       },
  { key: 'Ctrl+Shift+S', description: 'Screenshot to clipboard' },
  { key: 'Ctrl + O',    description: 'Open file'               },
  { key: 'Ctrl + Z',    description: 'Undo last annotation'    },
  { key: '+ / =',       description: 'Zoom in'                 },
  { key: '−',           description: 'Zoom out'                },
  { key: 'Ctrl + 0',    description: 'Reset zoom to 100%'      },
  { key: '?',           description: 'Show / hide this panel'  },
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Whether the shortcuts modal is currently visible */
let modalVisible = false;

/** The modal overlay element */
let modalEl = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Sets up the global keydown listener and populates the shortcuts modal.
 * Must be called once after the DOM is ready.
 *
 * @param {{ openFile: Function, setTool: Function, undo: Function }} callbacks
 *   openFile — called when Ctrl+O is pressed
 *   setTool  — (toolName: string|null) => void, called for tool shortcuts
 *   undo     — called when Ctrl+Z is pressed
 */
function init({ openFile, setTool, undo, fitPage, prevPage, nextPage, screenshot, togglePanel }) {
  buildModal();

  window.addEventListener('keydown', (e) => {
    handleKeyDown(e, { openFile, setTool, undo, fitPage, prevPage, nextPage, screenshot, togglePanel });
  });
}

// ---------------------------------------------------------------------------
// Key handler
// ---------------------------------------------------------------------------

/**
 * Dispatches a keydown event to the appropriate action.
 *
 * @param {KeyboardEvent} e
 * @param {{ openFile: Function, setTool: Function, undo: Function }} callbacks
 */
function handleKeyDown(e, { openFile, setTool, undo, fitPage, prevPage, nextPage, screenshot, togglePanel }) {
  // Ctrl+O: open file (fires regardless of editable target)
  if (e.ctrlKey && !e.shiftKey && e.key === 'o') {
    e.preventDefault();
    openFile();
    return;
  }

  // Ctrl+Z: undo (fires regardless of editable target)
  if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
    e.preventDefault();
    undo();
    return;
  }

  // Ctrl+Shift+S: screenshot (fires regardless of editable target)
  if (e.ctrlKey && e.shiftKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    screenshot();
    return;
  }

  // All remaining shortcuts are suppressed inside editable elements
  if (isEditableTarget(e.target)) return;

  // Note: +, -, Ctrl+0 zoom shortcuts are handled by canvas/input.js
  // because they need the canvas-container's bounding rect for the zoom origin.

  switch (e.key) {
    case 'v':
    case 'V':
      setTool(null); // null = cursor
      break;

    case 'h':
    case 'H':
      setTool('highlight');
      break;

    case 'd':
    case 'D':
      setTool('draw');
      break;

    case 'n':
    case 'N':
      // Note tool has no activate/deactivate — just give visual feedback
      setTool('note');
      break;

    case 's':
    case 'S':
      setTool('select');
      break;

    case 'e':
    case 'E':
      setTool('eraser');
      break;

    case '[':
      prevPage();
      break;

    case ']':
      nextPage();
      break;

    case 'f':
    case 'F':
      fitPage();
      break;

    case 'Escape':
      setTool(null);
      break;

    case 'p':
    case 'P':
      togglePanel();
      break;

    case '?':
      toggleModal();
      break;
  }
}

// ---------------------------------------------------------------------------
// Shortcuts modal
// ---------------------------------------------------------------------------

/**
 * Builds the shortcuts help modal from the SHORTCUT_DOCS list.
 * Populates the #shortcuts-list element with key/description pairs.
 */
function buildModal() {
  modalEl = document.getElementById('shortcuts-modal');

  const listEl = document.getElementById('shortcuts-list');
  if (!listEl) return;

  for (const { key, description } of SHORTCUT_DOCS) {
    const keyEl = document.createElement('span');
    keyEl.className   = 'shortcut-key';
    keyEl.textContent = key;

    const descEl = document.createElement('span');
    descEl.className   = 'shortcut-desc';
    descEl.textContent = description;

    listEl.appendChild(keyEl);
    listEl.appendChild(descEl);
  }

  // Close button
  const closeBtn = document.getElementById('btn-shortcuts-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => hideModal());
  }

  // Click on overlay backdrop (outside card) closes it
  if (modalEl) {
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) hideModal();
    });
  }

  // Escape key also closes the modal (handled above, but belt-and-suspenders)
  // Note: this is handled via the main keydown handler's 'Escape' case setting
  // setTool(null) — but we also need to close the modal specifically.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalVisible) {
      e.preventDefault();
      hideModal();
    }
  });
}

/**
 * Toggles the shortcuts modal visibility.
 */
function toggleModal() {
  if (modalVisible) {
    hideModal();
  } else {
    showModal();
  }
}

/**
 * Shows the shortcuts modal.
 */
function showModal() {
  if (!modalEl) return;
  modalEl.classList.remove('hidden');
  modalVisible = true;
}

/**
 * Hides the shortcuts modal.
 */
function hideModal() {
  if (!modalEl) return;
  modalEl.classList.add('hidden');
  modalVisible = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the event target is a text input element.
 * Most shortcuts should not fire when the user is typing.
 *
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
function isEditableTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { init };
