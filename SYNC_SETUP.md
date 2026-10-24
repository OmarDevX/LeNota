# Free PC ↔ Android sync with Supabase

Use the **Supabase Free plan** for the new version of LeNota. Your notes sync
through its hosted database and private file storage, including while your PC
is switched off. You do not need Render, a VPS, a domain, Docker, or the Python
sync server for this route. No Supabase project has been created or connected
for you; setup is completed in your own account.

## 1. Create a free Supabase project

1. Go to https://supabase.com and sign in/create an account.
2. Create an organization on the **Free** plan and then a new project, such as
   `LeNota`. Choose a region near you and save its database password privately.
3. Wait for the project to finish starting.

As checked on 2026-10-12, the Free plan includes 500 MB of database space,
1 GB of file storage, and 5 GB of uncached egress. Its maximum individual file
size is 50 MB. The app's normal mobile import limit remains 25 MB. This is free
within the plan's quotas, not unlimited storage/bandwidth. A project with low
activity over seven days can be paused; resume it from the Supabase dashboard
if needed. Your local notes remain available offline during that interruption.

Official limits: https://supabase.com/pricing and
https://supabase.com/docs/guides/storage/uploads/file-limits .

## 2. Set up the database and private attachments

1. Open the project's **SQL Editor** and start a new query.
2. Open `supabase/setup.sql` from this project in a text editor.
3. Copy the **whole file**, paste it into the SQL Editor, and run it.
4. The query should succeed. It creates:
   - `lenota_workspaces`, protected by row-level security;
   - two authenticated RPCs, `lenota_pull` and `lenota_push`;
   - a **private** Storage bucket called `lenota-notes`;
   - policies allowing users to access only their own workspace/files.

The script is safe to rerun. Keep the bucket private and keep RLS enabled.
Files are stored under `user-id/attachment-id/file-name`; no public attachment
URLs or administrator credentials are used by the app.

## 3. Create your one note account

For a personal project, the simplest path avoids setting up confirmation email:

1. Open **Authentication → Users** in the Supabase project dashboard.
2. Choose **Add user → Create new user** (wording may vary).
3. Enter your email and a password of at least 12 characters.
4. Enable **Auto Confirm User** if shown, or otherwise create a confirmed user.
5. You will use this email/password to **sign in** on both devices.

The account used to log in to the Supabase dashboard and the note account under
Authentication → Users are separate accounts. Creating the Supabase project
does not automatically create a LeNota note account.

For a one-person project, disable public sign-ups in Authentication settings
once your user exists. Existing users can still sign in. Alternatively, you can
use LeNota's Create account button when public sign-ups are enabled; hosted
Supabase normally requires email confirmation. If signup returns a confirmation
notice, confirm the email or confirm the user in the dashboard, then sign in.
The native app does not implement email-link/deep-link password reset UI in
this version; the dashboard owner can manage the user.

## 4. Copy the two project settings

Find your project's **Project URL** and **publishable API key** in its Connect
panel or project/API settings. These are not your database password.

They look like:

```text
Project URL: https://your-project-id.supabase.co
Publishable key: sb_publishable_...
```

The app accepts the new public key beginning `sb_publishable_`. Legacy JWT-style
`anon` keys are not accepted by this version: use/generate the publishable key.
Never put `sb_secret_...`, a `service_role` key, or your database password in
LeNota. The app uses your signed-in user session plus the public key; RLS enforces
which notes and files that user can access.

You enter the same project URL and publishable key on the PC and phone. They are
saved locally on each device; neither the user password nor administrative
secrets are saved in the note document or uploaded to the notes table.

## 5. Build the updated Fedora app

Extract `LeNota-mobile-free-sync.zip` and open a terminal in its `LeNota-mobile`
folder, where `Cargo.toml`, `apps`, and `supabase` are visible.

You need Node.js 22+, Rust, and the original Tauri Linux prerequisites. On
Fedora, install missing native dependencies with:

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel \
  gcc gcc-c++ make pkgconf-pkg-config
```

Then:

```bash
cd apps/desktop
npm ci
npm run tauri -- dev
```

This runs the updated native app. For an installable Fedora RPM:

```bash
npm run tauri -- build --bundles rpm
```

The RPM is under the project root's `target/release/bundle/rpm/`.
Keep the original identifier `dev.lenota.desktop`, so the app uses its existing
local workspace. The account migration runs automatically. Existing app
binaries do not gain the new provider until rebuilt.

## 6. Build/install Android

The native Android project is already included. With the original Android
SDK/NDK, full JDK, and Rust toolchain configured as in `MOBILE.md`:

```bash
# From apps/desktop
rustup target add aarch64-linux-android armv7-linux-androideabi
npm run android:apk
```

APKs are under `src-tauri/gen/android/app/build/outputs/apk/`. The wrapper builds
both 32-bit ARM and 64-bit ARM by default, covering phones with 32-bit Android.
The included Mobile GitHub Actions workflow is another build route.

Keep the existing app installed and update with the **same signing key** to
retain its data. If Android rejects the new APK because of a signature conflict,
preserve/export the existing notes and recover the signing setup before
changing the installation. Do not remove the existing app as a quick fix.
This ZIP is source code; it contains no newly built/signed APK or RPM.

## 7. Sign in and test both directions

In LeNota on the PC:

1. Open the **cloud icon → Account & sync**.
2. Select **Supabase — free cloud sync** (the default for an unlinked workspace).
3. Paste your project URL and publishable key.
4. Choose **Sign in** with the confirmed user from step 3.
5. Wait for **All changes synced**.

On Android:

1. Open **More → Account & sync**, or the cloud icon in the notebooks drawer.
2. Select the same Supabase service and enter the same URL and publishable key.
3. Sign in using the **same note-account email/password**.
4. Wait for **All changes synced**.

Write a small note on PC and confirm it appears on the phone. Edit it on the
phone and check the PC. Then close/switch off the PC and create another note on
the phone. That note remains in the cloud and appears on the PC the next time
you open LeNota. The first sync merges the existing notebooks from both devices;
it does not replace an entire device with the other device's workspace.

## Offline behavior, conflicts, and bandwidth

- Local SQLite saving continues offline. Notes/drawings remain available without
  internet. Sync retries while the app is open/visible, when it reconnects, and
  when it regains focus. Android OS background sync while the app is closed is
  not implemented.
- The app polls every 15 seconds. Unchanged cloud versions return only a small
  version response; they do not download your whole notebook again. Immutable
  attachments already acknowledged on this device are not re-uploaded.
- Changed versions use a full portable snapshot. The provider is optimized for
  personal workspaces, not large team datasets or frequent multi-megabyte edits.
  Snapshot metadata is limited to 32 MiB; free provider attachments to 50 MB each.
- Multiple devices use an atomic compare-and-swap RPC: if the cloud version
  changes during a push, the client fetches it, merges, and retries. An unseen
  concurrent push is never blindly overwritten.
- Different fields can merge. Simultaneous page body edits preserve both versions
  in the page's **History** (`sync-...` revisions). The incoming push becomes the
  current body. A deletion racing with an edit retains the edited item.
- Applying a sync response briefly locks input, flushes the latest draft, and
  compares the local database to the captured snapshot. New edits made during
  the request defer that import rather than being overwritten. Active pen/touch
  gestures finish before a changed editor is reloaded.
- Text, drawings/canvas content, notebook/section hierarchy/order, tags,
  favorites, revisions, trash, and managed images/files/audio sync. Embedded
  attachment paths are localized to the device. External filesystem resources
  are not uploaded unless imported as managed attachments.
- Gemini keys, device credentials, UI settings, and local backup files do not sync.
- User access tokens renew using per-device refresh tokens; rotated tokens are
  saved immediately. The password is not retained. Sign-out removes credentials
  locally even offline and revokes that device's session online. Supabase-issued
  access tokens can remain valid until expiry after sign-out.
- Account binding survives sign-out. This version uses one linked account/project
  per local workspace. Switching an already-linked self-hosted workspace to a
  different Supabase account/project requires a separate migration/profile;
  the app refuses to silently upload somebody's notes to a different account.
- The first successful import creates a local backup. Keep backups private:
  they include device account/session metadata. Supabase Free does not include
  automatic database backups. Preserve local backups and the project/user IDs.
- Cloud files no longer referenced by current notes are retained to protect
  history. Removing a note does not immediately reclaim the cloud file quota.

## Troubleshooting

- **Function not found / schema cache:** rerun `supabase/setup.sql` in the correct
  project, then retry. Make sure the URL and key belong to that same project.
- **Invalid login credentials / email not confirmed:** use the Authentication
  user from step 3, not your Supabase dashboard password. Confirm that user.
- **Publishable key error:** use `sb_publishable_...`, not a secret, legacy JWT,
  database password, or project ID.
- **Storage permission/size error:** ensure setup SQL ran, the bucket is private,
  and the file is at most 50 MB. Check the project's Storage/global size limit
  if it is lower than the bucket's configured limit.
- **Project paused:** resume the project in Supabase's dashboard. Offline notes
  remain on the device. Resume is subject to the provider's retention policy.
- **Quota exhausted:** check Supabase Usage. Stay on the Free plan if you want no
  charges; reduce/manage data or wait for bandwidth quotas to reset. Deleting
  current notes alone does not delete retained history files.
- **Conflict notice:** inspect the affected page's History and restore the desired
  version. Restored versions sync as normal edits.

## Optional self-hosted route

The original Python server is still available by selecting **Self-hosted
server** in the app. It uses `server/sync_server.py`, email/password accounts,
and portable SQLite snapshots. It is not required for Supabase and should not
be started for the free cloud setup above. Its old tests are retained to ensure
adding the free provider does not break that route.
