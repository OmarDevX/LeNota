# PDF page image correction (pdf-r2)

The imported PDF page entries were present, but their local asset URLs failed
to display. Managed images now read the saved attachment by its ID through the
existing native attachment API, then display a temporary image blob. Blob URLs
are allowed by the image CSP and are released when the image view is removed;
they are never stored in the note. A failed read or decode shows an error and
Retry button instead of only a filename.

Run this update:
1. Close all LeNota windows and extract into a fresh directory.
2. In LeNota-master, run `bash RUN_UPDATED_APP.sh` to rebuild and launch.
3. Confirm `pdf-r2` in the build badge.
4. Open the existing note. Imported pages with saved attachments will use the
   corrected loading path automatically; do not reimport just to reload them.

Insert a new PDF:
1. Open Write and click PDF printout, the first button.
2. Select the PDF, use quality 144, page range `all`, and size `large`.
3. Cancel the optional OCR question for faster insertion, or OK for searchable
   local OCR.

Rendering is local and retains the original PDF attachment. Gemini is not
involved. The existing limit is 200 pages per insertion. Poppler is required
(on Fedora: `sudo dnf install poppler-utils`); OCR additionally needs Tesseract.
The working Gemini and fast ink recognition routes are unchanged.

Verification:
- TypeScript check and production Vite build passed.
- 13 image loading and visual-selection tests passed, covering binary response
  normalization, MIME detection, read failures, resource cleanup, and CSP.
- A real three-page PDF rendered with pdftoppm at 144 DPI passed the attachment
  source / blob / PNG decoding check, including dimensions and pixel colors.
- Rust and AI worker sources are unchanged from r5. The native CSP configuration
  changed, so a native rebuild is required. Cargo and a native WebView were
  unavailable here; native image display remains unverified.
