# Run the LeNota reference workspace build

The ZIP contains source code, not a precompiled RPM or AppImage. Launching an
older installed LeNota from the application menu will continue to run the old
bugs.

1. Close every running LeNota window.
2. Extract this ZIP into a new directory. Do not merge it into an older source
   directory.
3. From the extracted `lenota` directory, run:

   ```bash
   ./RUN_UPDATED_APP.sh
   ```

4. Confirm that `v0.28.0` appears beside **LeNota** in the application header.
   If that badge is absent, this source is not the application being displayed.

To make an installable RPM/AppImage after verifying the correction, run:

```bash
./BUILD_UPDATED_APP.sh
```

Then install the newly generated package before using the desktop application
shortcut again.

This patch archive is intentionally named `lenota-v0.28.0-reference-workspace.zip`.
Do not use an older file named only `lenota.zip`.

The normal launcher uses WebKitGTK's faster renderer. This release keeps that
performance path while rebuilding the normal workspace around the approved
rail, notebook drawer, floating tools, bordered canvas, and optional inspector.
Focus Mode uses a single full-window drawable canvas with all controls floating
above it; it does not reserve a separate title area. Light and dark themes are
complete and independently selectable in either workspace mode. Ink converted
to text, math, or shapes keeps the color that was visible on the canvas. Size
fields keep their recommended choices but also accept directly typed positive
values. If your machine shows a blank or corrupted canvas, close LeNota and
use `./RUN_SAFE_RENDERER.sh` as a compatibility fallback.
