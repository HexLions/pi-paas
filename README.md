[![Pi-PaaS](assets/banner.svg)](assets/banner.svg)

[![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/HexLions/pi-paas/actions/workflows/ci.yml/badge.svg)](https://github.com/HexLions/pi-paas/actions/workflows/ci.yml)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-Debian%20%7C%20Fedora%20%7C%20Arch%20%7C%20Alpine%20%7C%20SUSE-orange.svg)](#-supported-distributions)

**The tiniest self-hosted PaaS for your Raspberry Pi (and any Linux box)**
Deploy, manage, edit and back up web apps from your browser.
No Docker required: apps run as native processes, supervised by Pi-PaaS.

---

## 🔀 Two Editions

|  | **Standalone** (`main` branch) | **Docker Edition** (`docker` branch) |
| --- | --- | --- |
| **Apps run as** | Native processes | Docker containers |
| **Isolation** | Optional unprivileged app user | Full container isolation |
| **Requires Docker** | ❌ No | ✅ Yes |
| **Install** | `bash install.sh` | `docker compose up -d` |
| **Best for** | Raspberry Pi, lightweight setups | Production, multi-app servers |

👉 **Want the Docker edition?** Switch to the [`docker` branch](https://github.com/HexLions/pi-paas/tree/docker). It is still based on v1.0 and does not have the v1.1 changes below yet.

---

## ✨ Features

* 🚀 **One-click deploy**: upload a `.zip` or a single `.html` file and it's live
* 🔌 **4 app types**: static HTML, Node.js, Python/Flask, React/Vue/Vite
* 🔐 **Login-protected panel**: password with scrypt hashing, secure session cookies, CSRF protection and login rate limiting
* 🧱 **Background builds**: `npm install`, `pip install` and `npm run build` run in the background and stream into the app log
* ↩️ **Safe updates**: if a new version fails to build, the previous one is put back automatically
* ♻️ **Crash recovery**: crashed apps restart with backoff; an app that keeps crashing is parked instead of looping
* 🗃️ **Databases**: SQLite or PostgreSQL per app; PostgreSQL apps get their own database **and** login, ready in `DATABASE_URL`
* 💽 **Persistent volume**: every app gets a `DATA_DIR` folder that survives updates
* ⚙️ **Environment variables & start command** per app, editable from the panel
* 📂 **Built-in code editor**: CodeMirror with syntax highlighting, search & replace, folding, autocomplete; file upload and download
* 📋 **Live logs** with auto-refresh and automatic rotation
* 💾 **Backups**: manual or scheduled (daily/weekly), with one-click restore, download and rotation; includes app files, data volume and PostgreSQL dump
* 🌡️ **System stats**: CPU temperature, load, memory and free disk in the header
* 🌍 **6 languages**: English, Italiano, Español, Français, Deutsch, 日本語
* 🌓 **Dark and light theme**, works on phones
* 📴 **Works offline**: no CDN needed, everything is served by the Pi
* 🐧 **Multi-distro installer**: systemd or OpenRC

---

## 🚀 Quick Start

```bash
git clone https://github.com/HexLions/pi-paas.git
cd pi-paas
sudo bash install.sh
# → http://<your-ip>:9000
```

The installer asks you to choose a panel password. If you skip it, a random one is generated, printed at the end, and saved in `~/pi-paas-data/initial-password.txt` until you change it from the panel.

### Installer options

| Option | Meaning |
| --- | --- |
| `--port N` | Panel port (default `9000`) |
| `--no-postgres` | Do not install PostgreSQL (SQLite still works) |
| `--nginx` | Write an nginx snippet that publishes the panel at `/pi-paas/` |
| `--app-user NAME` | Run apps and builds as this unprivileged user (created if missing) |
| `--no-app-user` | Run apps as the panel user |
| `--password PW` | Set the panel password without being asked |
| `-y`, `--yes` | Do not ask questions |
| `--uninstall` | Remove the service and code, keep your data |

On a **new install as root**, apps run as the unprivileged user `pipaas-apps` by default, so an uploaded app cannot read the panel's password or other system files. Upgrades keep their previous behaviour unless you pass `--app-user`.

---

## 🐧 Supported Distributions

| Family | Distributions |
| --- | --- |
| **Debian** | Debian, Ubuntu, DietPi, Raspberry Pi OS, Linux Mint, Pop!_OS, Kali, Zorin, elementary |
| **Fedora** | Fedora, CentOS, Rocky Linux, AlmaLinux, RHEL |
| **Arch** | Arch Linux, Manjaro, EndeavourOS, Garuda |
| **Alpine** | Alpine Linux (OpenRC) |
| **SUSE** | openSUSE Leap, openSUSE Tumbleweed, SLES |

---

## 📁 Layout

```
~/pi-paas/                  ← Code (safe to delete & reinstall)
├── backend/                  server.js (entry), http.js (API), apps.js, processes.js,
│                             build.js, backups.js, database.js, archive.js, auth.js …
├── frontend/                 index.html, app.js, i18n.js, style.css
├── assets/
└── install.sh

~/pi-paas-data/             ← Your data (never touched by updates)
├── apps/<id>/                app code
├── volumes/<id>/             persistent data (DATA_DIR, SQLite)
├── backups/<id>/             .tar.gz backups
├── logs/<id>.log             app logs (rotated at 5 MB)
├── registry.json             app list (mode 600)
└── auth.json                 panel password hash (mode 600)
```

---

## 📱 Deploying Apps

Every app gets these environment variables:

| Variable | Description |
| --- | --- |
| `PORT` | Assigned port (3001–3200). Your app must listen on it. |
| `DATA_DIR` | Folder that survives updates; put uploads and data files here |
| `DATABASE_URL` | Database connection string (`sqlite:/…` or `postgresql://user:pass@localhost:5432/db`) |
| `SQLITE_PATH` | Path to the `.db` file (SQLite only) |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | PostgreSQL connection (PostgreSQL only) |
| `PIPAAS_APP_ID` | The app's id |

Add your own variables from **⚙ Settings** on the app card. Apps do **not** inherit the panel's environment.

### Static HTML/CSS/JS

Upload a `.zip` containing an `index.html`, or upload a single `.html` file.

### Node.js

Pi-PaaS runs `npm ci`/`npm install --omit=dev`, then `npm start` if `package.json` has a start script, otherwise `server.js`, `app.js`, `index.js` or `main.js`.

```js
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
```

### Python / Flask

Pi-PaaS creates a `venv`, installs `requirements.txt` and runs `server.py`, `main.py`, `app.py` or `wsgi.py`. Listen on `0.0.0.0`:

```python
import os
app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 3000)))
```

For production servers set a **custom start command**, e.g. `venv/bin/gunicorn -b 0.0.0.0:$PORT app:app` (add `gunicorn` to `requirements.txt`).

### React / Vue / Vite

Upload the project with `package.json`. Pi-PaaS runs `npm install` (including devDependencies) and `npm run build`, then serves `dist/`, `build/` or `out/`.

---

## 💾 Backups

* **Manual**: "Create backup now"
* **Scheduled**: daily (3:00) or weekly (Sunday 3:00)
* **Contents**: app files (without `node_modules`/`venv`), the data volume, the PostgreSQL dump, metadata
* **Restore**: stops the app, restores files, data and database, reinstalls dependencies, starts it again
* **Rotation**: keeps the last 5 per app (`PIPAAS_MAX_BACKUPS`)

---

## 🔧 Configuration

The installer writes these into the service file; you can also set them by hand.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIPAAS_PORT` | `9000` | Panel port |
| `PIPAAS_HOST` | `0.0.0.0` | Panel listen address |
| `PIPAAS_DATA_DIR` | `~/pi-paas-data` | Data folder |
| `PIPAAS_PORT_RANGE` | `3001-3200` | Ports handed out to apps |
| `PIPAAS_APP_USER` | *(empty)* | Run apps and builds as this user (panel must run as root) |
| `PIPAAS_PUBLIC_HOST` | *(request host)* | Host name used in app links |
| `PIPAAS_MAX_BACKUPS` | `5` | Backups kept per app |
| `PIPAAS_UPLOAD_LIMIT_MB` | `100` | Maximum upload size |
| `PIPAAS_BUILD_TIMEOUT` | `600` | Seconds allowed for install + build |
| `PIPAAS_MAX_LOG_MB` | `5` | Log size before rotation |
| `PIPAAS_TRUST_PROXY` | *(off)* | Set to `1` behind a local reverse proxy |
| `PIPAAS_PASSWORD` | *(empty)* | First password, used only when none is set yet |
| `PIPAAS_AUTH` | *(on)* | `off` disables the login. Only behind your own authentication. |

Forgot the password? On the server:

```bash
node ~/pi-paas/backend/cli.js set-password
```

---

## 🔄 Updating

```bash
cd ~/pi-paas
git pull origin main
sudo bash install.sh     # your data in ~/pi-paas-data/ is preserved
```

Upgrading from v1.0: the registry is migrated automatically, existing apps keep running, and you are asked for a panel password (or one is generated).

## 🛠️ Service Management

```bash
sudo systemctl status pi-paas
sudo systemctl restart pi-paas
journalctl -u pi-paas -f
```

On Alpine (OpenRC): `rc-service pi-paas status` and `/var/log/pi-paas.log`.

---

## 🧑‍💻 Development

```bash
npm install
npm run dev      # panel on :9000, data in ./.dev-data, password "devpassword"
npm test         # unit + API tests (real HTTP, real child processes)
npm run lint     # syntax check + shellcheck
```

Tests need Node 18+ and `tar`; no root, PostgreSQL or Python.

---

## 🔒 Security notes

* The panel can run arbitrary code on your machine: that is its job. Keep it on your LAN or behind a VPN, and use a strong password.
* Apps share the app user with each other. They are kept away from the panel and the system, not from each other.
* PostgreSQL passwords are stored in `registry.json` (mode 600) and only shown in the database dialog of their app.

---

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md).

## 🤝 Contributing

Contributions, issues and feature requests are welcome! Check the [issues page](https://github.com/HexLions/pi-paas/issues). Please run `npm test` before opening a pull request.

## 📄 License

Licensed under the **GNU General Public License v3.0**, see [LICENSE](LICENSE).

Made with ❤️ by [HexLions](https://github.com/HexLions)
