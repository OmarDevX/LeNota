# AI context checkmarks and compact dialogs

- Each canvas note has a checkmark button next to its copy-link, duplicate and delete buttons.
- Click it to include/exclude the note in AI context. The marked state turns purple.
- Clicking a mark switches AI context scope to **Checked notes**. The marked IDs are saved locally for that page, independently of ordinary canvas selection.
- `/ask` and Ask Selection both use the chosen marked notes when scope is Checked notes; default `/ask` scope remains the current note unless marks are used.
- AI Context dialog now displays selected count, Check all/Clear checks, and an editable outgoing context preview instead of a stacked list.
- AI Providers dialog is capped at 480 px and AI Context at 720 px, retaining responsive limits for narrow screens.
- The fixed native formatting prompt still applies; the editor controls outgoing question and page text.
- Existing provider settings and authentication are unchanged.

Use `bash RUN_UPDATED_APP.sh` after extracting the full project. Native Rust compilation and user-specific AI credentials are not exercised by browser tests.
