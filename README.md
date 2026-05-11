[![Pi-PaaS](assets/banner.svg)](assets/banner.svg)

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/HexLions/pi-paas)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](https://github.com/HexLions/pi-paas/blob/main/LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
[![Docker Required](https://img.shields.io/badge/docker-required-2496ED.svg?logo=docker&logoColor=white)](https://www.docker.com)
[![Platforms](https://img.shields.io/badge/platforms-any%20Linux%20with%20Docker-orange.svg)](https://github.com/HexLions/pi-paas)

**The tiniest self-hosted PaaS for your Raspberry Pi (and any Linux box) — Docker Edition**  
Deploy, manage, edit and backup web apps directly from your browser.  
Each app runs in its own Docker container with full isolation.

---

## 🔀 Two Editions

|  | **Standalone** (`main` branch) | **Docker Edition** (`docker` branch) |
| --- | --- | --- |
| **Apps run as** | Native processes | Docker containers |
| **Isolation** | Shared filesystem | Full container isolation |
| **Requires Docker** | ❌ No | ✅ Yes |
| **Install** | `bash install.sh` | `docker compose up -d` |
| **Best for** | Raspberry Pi, lightweight setups | Production, multi-app servers |
| **App deployment** | Upload ZIP → process spawned | Upload ZIP → image built → container started |
| **Port management** | Direct port binding | Docker port mapping |
| **Auto-Dockerfile** | N/A | Generated for Node, Python, Static if missing |
| **Custom Dockerfile** | N/A | ✅ Use your own if included in ZIP |

```
HexLions/pi-paas
├── main    ← Standalone Edition
└── docker  ← Docker Edition (this branch)
```

👉 **Want the Standalone edition?** Switch to the [`main` branch](https://github.com/HexLions/pi-paas/tree/main)

---

## ✨ Features

* 🚀 **One-click deploy** — Upload a `.zip` or single `.html` file and it's live
* 🔌 **4 app types** — Static HTML, Node.js, Python/Flask, React/Vue
* 🐳 **Full container isolation** — Each app runs in its own Docker container
* 🤖 **Auto-Dockerfile generation** — No Dockerfile? Pi-PaaS generates one for Node, Python and Static apps
* 📄 **Custom Dockerfile support** — Include your own `Dockerfile` in the ZIP for full control
* 🗃️ **3 database options** — None, SQLite, or PostgreSQL (per-app, custom naming)
* 🎯 **Port picker** — Choose your port or auto-assign, with live availability check against Docker bindings and system processes
* 📂 **Built-in code editor** — CodeMirror with syntax highlighting for 10+ languages
* 📋 **Live logs** — View each container's stdout/stderr from the panel
* 💾 **Backup system** — Manual or scheduled (daily/weekly) backups with one-click restore, download, and automatic rotation (keeps last 5)
* 🗃️ **Database management** — Rename SQLite or PostgreSQL databases from the panel
* 🔄 **Auto-restart** — Containers restart automatically on reboot via Docker restart policy

---

## 🚀 Quick Start

### Docker Edition

```bash
git clone -b docker https://github.com/HexLions/pi-paas.git
cd pi-paas
docker compose up -d
# → http://<your-ip>:9000
```

> Requires Docker and Docker Compose v2 installed on the host.

---

## 📁 Architecture

```
pi-paas/                        ← Project root
├── Dockerfile
├── docker-compose.yml
├── nginx.conf
├── backend/server.js           ← Uses dockerode instead of child_process
├── frontend/index.html
└── .dockerignore

pi-paas-data (Docker volume)    ← Persistent data (never lost on updates)
├── apps/
├── backups/
├── uploads/
└── registry.json
```

---

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

```js
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

Upload the full project with `package.json`. Pi-PaaS runs `npm install` + `npm run build` and serves `build/` or `dist/`.

### Custom Dockerfile

Include a `Dockerfile` in your ZIP and Pi-PaaS will use it directly:

```
my-app.zip
├── Dockerfile
├── server.js
└── package.json
```

---

## 🎯 Port Selection

* **Leave empty** → auto-assigns next free port (3001–3200)
* **Enter a specific port** → click "Check" to verify availability
* **Change later** → update port from the Update modal

The checker scans both Pi-PaaS apps, Docker port bindings and system processes.

---

## 🗃️ Database Management

* Choose **SQLite**, **PostgreSQL**, or **None** at deploy time
* Set a **custom database name** (auto-generated if empty)
* **Rename** databases later via the 🗃️ DB button

| Variable | Description |
| --- | --- |
| `PORT` | Assigned port (3001–3200) |
| `DATABASE_URL` | Database connection string |
| `SQLITE_PATH` | Path to `.db` file (SQLite only) |
| `PGDATABASE` | PostgreSQL database name (PG only) |

---

## 💾 Backup System

* **Manual** — click "Create Backup Now" for instant `.tar.gz` archive
* **Scheduled** — Daily (3am) or Weekly (Sunday 3am) via `node-cron`
* **Contents** — app files + PostgreSQL dump + SQLite DB + metadata
* **Restore** — one-click: stops container, restores files + DB, restarts
* **Download** — grab any backup as `.tar.gz`
* **Auto-rotation** — keeps last 5 backups per app

Backups stored in the `pi-paas-data` Docker volume under `backups/<app-id>/`.

---

## ⌨️ Editor Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+S` | Save file |
| `Ctrl+F` | Find |
| `Ctrl+H` | Find & Replace |
| `Ctrl+/` | Toggle comment |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Tab` / `Shift+Tab` | Indent / Unindent |
| `Ctrl+Space` | Autocomplete |
| `Ctrl+J` | Jump to matching tag |

Supported: HTML, CSS, JavaScript, JSON, Python, Markdown, SQL, Shell, YAML, XML.

---

## 🔄 Updating

```bash
git pull origin docker
docker compose up -d --build    # Volume data preserved!
```

---

## 🛠️ Service Management

```bash
docker compose ps
docker compose logs -f
docker compose restart
docker compose down   # stop (data preserved in volume)
```

---

## 🔗 Accessing the Panel

| Method | URL |
| --- | --- |
| **Direct** | `http://<IP>:9000` |
| **Via nginx** | `http://<IP>/pi-paas/` |
| **Each app** | `http://<IP>:<assigned-port>` |

---

## 📋 Changelog

### v1.0.0 (Current)

* 🐳 Full Docker isolation — each app in its own container via dockerode
* 🤖 Auto-Dockerfile generation for Node, Python and Static apps
* 📄 Custom Dockerfile support
* 💾 Backup system with manual/scheduled backups, restore, download, auto-rotation
* 🗃️ Database management — custom DB names, rename SQLite/PostgreSQL
* 🎯 Port picker with Docker + system port scanning
* 📂 Built-in CodeMirror editor with syntax highlighting
* 📁 File manager with create/edit/delete
* 📦 Safe update architecture (code vs volume data separation)
* 🚀 Deploy static HTML, Node.js, Python, React apps

---

## 🤝 Contributing

Contributions, issues and feature requests are welcome! Check the [issues page](https://github.com/HexLions/pi-paas/issues).

---

## 📄 License

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](https://github.com/HexLions/pi-paas/blob/main/LICENSE) file for details.

This means you are free to use, modify and distribute this software, but any derivative work must also be released under GPL-3.0 with source code available.

Made with ❤️ by [HexLions](https://github.com/HexLions)
