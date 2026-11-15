# Changelog

## v1.2.0 (unreleased)

### Accounts and access
- Several users with roles: viewer (reads), operator (deploys and runs apps), admin (users, settings, updates). Existing installs keep their password as the `admin` user.
- Two-step login with any authenticator app (TOTP, QR code in the panel); a code works only once.
- API tokens for scripts and other tools, never with more rights than their owner.
- `cli.js`: `set-password <user>`, `add-user`, `reset-2fa`, `users`.

### Deploying
- Deploy from a git repository (https or ssh, private ones with a token, a subfolder), and redeploy on every push through a signed webhook (GitHub, Gitea, GitLab).
- Template catalogue: link hub, personal page, Notes API (Node), Flask with SQLite, PHP guestbook.
- `pipaas`, a one-file command-line client: `pipaas deploy ./my-app` packs the folder, picks the type and follows the build. The panel serves it at `/cli/pipaas.js`.
- Every update keeps the code it replaced (3 versions by default, `PIPAAS_KEEP_RELEASES`); roll back from the panel or with `pipaas rollback`.
- New app types: PHP, Deno, Bun, programs (Go, Rust…) and Docker (the project's Dockerfile).

### Running
- Resource limits per app: memory and CPU (a systemd scope when the panel runs as root), and CPU priority.
- CPU and memory per app with one-hour charts; HTTP health checks that can restart an app that stops answering.
- Scheduled tasks per app (cron syntax), with the app's variables and user.
- Built-in reverse proxy: `http://<app>.local` on the LAN (announced over mDNS), `<app>.<your domain>` and custom domains, with Let's Encrypt certificates and HTTPS redirects.
- Alerts to ntfy, Telegram, a webhook or the browser (Web Push) for crashes, apps that stop answering, failed deploys and backups, a hot CPU, a full disk and new versions; an activity list in the panel.

### Data
- Backups are checked right after they are made, and copied off the Pi to a folder (a mounted NAS) or any rclone remote, optionally encrypted (AES-256-GCM); remote copies can be restored.
- SQL console for each app's SQLite or PostgreSQL database: read-only unless an admin allows changes.
- Live logs (Server-Sent Events) and search across the current and previous log.

### Panel
- Installable as an app on phones and computers (over HTTPS), with push notifications.
- Self-update from GitHub releases, from the panel.
- `GET /api/summary` for dashboards; a HexDeck widget uses it.
- Docker Edition: the same code in container mode (`PIPAAS_RUNTIME=docker`), with a Dockerfile generated for each app type when the project has none; `docker compose up -d` starts it.
- The installer sets up git, copies the templates and the CLI, and restarts the panel through supervise-daemon on OpenRC.

## v1.1.0 (2026-11-14)

### Security
- The panel now requires a login: scrypt password hash, HttpOnly SameSite=Strict session cookie, CSRF header check, rate limiting on failed logins. First password from the installer, `PIPAAS_PASSWORD`, or generated into `initial-password.txt`.
- No more shell command strings: every external command runs without a shell, PostgreSQL names are validated and SQL goes through stdin.
- ZIP files are extracted in JavaScript with checks against path traversal ("zip slip"), symbolic links and archive bombs. The `unzip` package is no longer needed.
- File manager paths are resolved safely, including symlinks that point outside the app.
- Backup file names are validated (no more `../` in download, restore or delete).
- Apps no longer inherit the panel's environment, and can run as an unprivileged user (`PIPAAS_APP_USER`, default for new root installs).
- PostgreSQL apps get their own login role with a random password instead of sharing the superuser.
- `registry.json` and `auth.json` are mode 600; strict Content-Security-Policy and other security headers on the panel.
- XSS fix: app names with quotes could break out of `onclick` attributes.

### New
- Deploy, update and restore run as background jobs; build output streams into the app log, so slow `npm install` on a Pi no longer times out the request.
- Automatic rollback when an update fails to build.
- Crash recovery: restart with exponential backoff, parked as "crashed" after 5 crashes in 10 minutes.
- Per-app environment variables and custom start command.
- Per-app persistent `DATA_DIR` volume; new SQLite databases live there.
- Backups include the data volume, and restore reinstalls dependencies.
- File upload and download in the file manager; the editor refuses to overwrite a file changed on disk.
- Log auto-refresh, clear and rotation.
- Header with CPU temperature, load, memory and free disk.
- New panel design: the port range drawn as a pin header (one lit pin per app, coloured by state), apps as a list with a "More" menu, a light board-green theme with a matching dark one, no emoji or all-caps labels.
- Drop a .zip or .html anywhere on the panel to start a deploy with it.
- Six languages (en, it, es, fr, de, ja), light and dark theme, mobile layout, app filter.
- CodeMirror is served locally: the panel works without internet access.
- The panel works behind a reverse proxy under a sub-path (relative URLs).
- Configuration through environment variables (`PIPAAS_*`), `cli.js set-password`.
- Installer: options (`--port`, `--no-postgres`, `--nginx`, `--app-user`, `--password`, `--uninstall`), Node 22 LTS, OpenRC logging, optional nginx snippet instead of overwriting the default site.
- Test suite (`npm test`) and GitHub Actions CI on Node 18–24 with shellcheck.

### Fixed
- React/Vue builds failed because devDependencies were skipped before `npm run build`.
- Python output did not show in the logs (buffered stdout).
- Stopping an app left `npm start` children running; apps now run in their own process group.
- Stopping by a PID saved before a reboot could kill an unrelated process.
- Apps started with the panel's working environment, including its secrets.
- Panel shutdown now stops apps cleanly; they come back at the next start.
- A failed deploy left a half-created folder behind.

### Changed
- Express 5, multer 2, node-cron 4 (all known advisories fixed).
- The duplicate `pi-paas/` folder in the repository has been removed; its installer and translations were merged.

## v1.0.0

- Deploy static HTML, Node.js, Python and React apps from a ZIP or HTML file
- Backups with schedule, restore, download and rotation
- SQLite / PostgreSQL per app, rename from the panel
- Port picker with system port scan
- CodeMirror editor and file manager
- Multi-distro installer, systemd/OpenRC
