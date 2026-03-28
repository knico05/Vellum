/**
 * pdfManager.js — INTERNAL MODULE (not imported by any module outside src/pages/)
 *
 * This file is now a thin stub. All public page-management functionality has
 * moved to src/pages/pageManager.js, which is the module other parts of the
 * app should import.
 *
 * pageManager.js directly imports from loader.js and page.js — it does not
 * need this file at all. This file is kept only as a reference / placeholder
 * so that git history shows the migration path.
 *
 * To migrate a caller that still imports from here:
 *   - Replace `from '../pdf/pdfManager.js'` with `from '../pages/pageManager.js'`
 *   - openPDF       → openPDF (same name)
 *   - getPages()    → getPageList() (returns full page list incl. blank pages)
 *   - getPageCount  → getPageCount
 *   - goToPage(n)   → goToPageIndex(n)
 *   - fitPage       → fitPage
 *   - getCurrentPdfPath       → getCurrentPdfPath
 *   - getCurrentFingerprint   → getCurrentFingerprint
 */

'use strict';

// This module intentionally exports nothing.
// All exports are in src/pages/pageManager.js.
