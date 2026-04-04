<p align="center">
  <img src="assets/banner.svg" alt="Pi-PaaS" width="100%"/>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue.svg" alt="Version"/>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"/>
  <img src="https://img.shields.io/badge/node-%3E%3D18-green.svg" alt="Node 18+"/>
  <img src="https://img.shields.io/badge/docker-not%20required-lightgrey.svg" alt="No Docker"/>
  <img src="https://img.shields.io/badge/platforms-Debian%20%7C%20Ubuntu%20%7C%20Fedora%20%7C%20Arch%20%7C%20Alpine-orange.svg" alt="Platforms"/>
</p>

<p align="center">
  <strong>The tiniest self-hosted PaaS for your Raspberry Pi (and any Linux box)</strong><br/>
  Deploy, manage, edit and backup web apps directly from your browser.<br/>
  No Docker. No Git. Just upload a ZIP and go.
</p>

---

## ✨ Features

- 🚀 **One-click deploy** — Upload a `.zip` or single `.html` file and it's live
- 🔌 **4 app types** — Static HTML, Node.js, Python/Flask, React/Vue
- 🗃️ **3 database options** — None, SQLite, or PostgreSQL (per-app, custom naming)
- 🎯 **Port picker** — Choose your port or auto-assign, with live availability check against system processes
- 📂 **Built-in code editor** — CodeMirror with syntax highlighting for 10+ languages, line numbers, bracket matching, code folding, search & replace, autocomplete
- 📋 **Live logs** — View each app's stdout/stderr from the panel
- 💾 **Backup system** — Manual or scheduled (daily/weekly) backups with one-click restore, download, and automatic rotation (keeps last 5)
- 🗃️ **Database management** — Rename SQLite or PostgreSQL databases from the panel
- 🔄 **Auto-restart** — Apps survive reboots via systemd/OpenRC
- 📦 **Safe updates** — App data lives in `~/pi-paas-data/`, never touched by Pi-PaaS code updates
- 🐧 **Multi-distro** — Debian, Ubuntu, DietPi, Raspberry Pi OS, Fedora, CentOS, Arch, Alpine, openSUSE

## 🚀 Quick Start

```bash
# Clone the repo
git clone https://github.com/HexLions/pi-paas.git
cd pi-paas

# Run the installer (auto-detects your distro)
bash install.sh

# Open your browser
# http://<your-ip>:9000
```

Or deploy via SCP:

```bash
scp -r pi-paas/ root@your-pi:~/
ssh root@your-pi
cd ~/pi-paas && bash install.sh
```

## 🐧 Supported Distributions

| Family | Distributions |
|--------|--------------|
| **Debian** | Debian, Ubuntu, DietPi, Raspberry Pi OS, Linux Mint, Pop!_OS, Kali, Zorin, elementary |
| **Fedora** | Fedora, CentOS, Rocky Linux, AlmaLinux, RHEL |
| **Arch** | Arch Linux, Manjaro, EndeavourOS, Garuda |
| **Alpine** | Alpine Linux |
| **SUSE** | openSUSE Leap, openSUSE Tumbleweed, SLES |

The installer auto-detects your distribution via `/etc/os-release` and uses the correct package manager.

## 📁 Architecture

```
~/pi-paas/                  ← Code (safe to delete & reinstall)
├── backend/server.js
├── frontend/index.html
├── assets/
│   ├── logo.svg
│   └── banner.svg
├── install.sh
├── package.json
├── LICENSE
└── README.md

~/pi-paas-data/             ← Your data (NEVER touched by updates)
├── apps/                   ← Deployed app files
│   ├── my-portfolio/
│   └── api-backend/
├── backups/                ← Per-app backup archives
│   ├── my-portfolio/
│   │   ├── 1711900000000.tar.gz
│   │   └── 1711800000000.tar.gz
│   └── api-backend/
├── logs/                   ← Per-app log files
├── uploads/                ← Temp upload storage
└── registry.json           ← App registry
```

## 📱 Deploying Apps

### Static HTML/CSS/JS

Upload a `.zip` containing an `index.html`, or upload a single `.html` file directly:

```
my-site.zip
├── index.html
├── style.css
└── script.js
```

### Node.js

Your app must read the port from `process.env.PORT`:

```javascript
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
```

### Python / Flask

Your app must read the port from `os.environ['PORT']`:

```python
import os
port = int(os.environ.get('PORT', 3000))
app.run(host='0.0.0.0', port=port)
```

### React / Vue

Upload the full project with `package.json`. Pi-PaaS runs `npm install` + `npm run build` automatically and serves the `build/` or `dist/` folder.

## 🎯 Port Selection

When deploying, you can either:

- **Leave the port field empty** → Pi-PaaS auto-assigns the next free port (3001–3200)
- **Enter a specific port** → Click "Check" to verify availability

The port checker scans both Pi-PaaS apps and system processes (via `ss`/`netstat`). You can also change an app's port later from the Update modal.

## 🗃️ Database Management

When deploying an app, you can:

- Choose **SQLite**, **PostgreSQL**, or **None**
- Optionally set a **custom database name** (auto-generated if left empty)

After deployment, click the **🗃️ DB** button on any app card to **rename** the database:
- **SQLite** — renames the `.db` file
- **PostgreSQL** — runs `ALTER DATABASE RENAME`

Environment variables injected into your app:

| Variable | Description |
|----------|-------------|
| `PORT` | Assigned port (3001–3200) |
| `DATABASE_URL` | Database connection string |
| `SQLITE_PATH` | Path to `.db` file (SQLite only) |
| `PGDATABASE` | PostgreSQL database name (PG only) |

## 💾 Backup System

Click **💾 Backups** on any app card to access the backup panel:

### Manual Backups
Click **"Create Backup Now"** to immediately create a `.tar.gz` archive containing:
- All app files (excluding `node_modules`, `venv`, `__pycache__`)
- PostgreSQL database dump (`pg_dump`) if applicable
- SQLite `.db` file (included with app files)
- Metadata JSON with app info and timestamp

### Scheduled Backups
Set a schedule per-app:
- **Off** — no automatic backups
- **Daily** — runs at 3:00 AM every day
- **Weekly** — runs at 3:00 AM every Sunday

Schedules persist across Pi-PaaS restarts via `node-cron`.

### Backup Management
- **Download** — download any backup as a `.tar.gz` file
- **Restore** — one-click restore: stops the app, replaces all files, restores the database, restarts the app
- **Delete** — remove individual backups
- **Auto-rotation** — only the last 5 backups are kept per app (oldest are deleted automatically)

Backups are stored in `~/pi-paas-data/backups/<app-id>/`.

## ⌨️ Editor Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save file |
| `Ctrl+F` | Find |
| `Ctrl+H` | Find & Replace |
| `Ctrl+/` | Toggle comment |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Tab` | Indent |
| `Shift+Tab` | Unindent |
| `Ctrl+Space` | Autocomplete |
| `Ctrl+J` | Jump to matching tag |

Supported languages: HTML, CSS, JavaScript, JSON, Python, Markdown, SQL, Shell, YAML, XML.

## 🔄 Updating Pi-PaaS

Your apps and backups are safe — they live in `~/pi-paas-data/`:

```bash
cd ~
rm -rf pi-paas/
git clone https://github.com/HexLions/pi-paas.git
cd pi-paas && bash install.sh   # Apps, DBs, backups all untouched!
```

## 🛠️ Service Management

```bash
# Status
systemctl status pi-paas

# View panel logs
journalctl -u pi-paas -f

# Restart the panel
systemctl restart pi-paas
```

## 🔗 Accessing the Panel

| Method | URL |
|--------|-----|
| **Direct** | `http://<IP>:9000` |
| **Via nginx** | `http://<IP>/pi-paas/` |
| **Each app** | `http://<IP>:<assigned-port>` |

## 📋 Changelog

### v1.0.0 (Current)
- 💾 Backup system with manual/scheduled backups, restore, download, auto-rotation
- 🗃️ Database management — custom DB names, rename SQLite/PostgreSQL
- 🎯 Port picker with system port scanning
- 📂 Built-in CodeMirror editor with syntax highlighting
- 📁 File manager with create/edit/delete
- 🐧 Multi-distro installer (Debian, Fedora, Arch, Alpine, SUSE)
- 📦 Safe update architecture (code vs data separation)
- 🚀 Deploy static HTML, Node.js, Python, React apps
- 🔄 Auto-restart on reboot via systemd/OpenRC

## 🤝 Contributing

Contributions, issues and feature requests are welcome! Feel free to check the [issues page](https://github.com/HexLions/pi-paas/issues).

## 📄 License

[MIT](LICENSE) — Made with ❤️ by [HexLions](https://github.com/HexLions)
