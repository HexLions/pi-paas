[![Pi-PaaS](assets/banner.svg)](assets/banner.svg)

[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/HexLions/pi-paas/actions/workflows/ci.yml/badge.svg)](https://github.com/HexLions/pi-paas/actions/workflows/ci.yml)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-Debian%20%7C%20Fedora%20%7C%20Arch%20%7C%20Alpine%20%7C%20SUSE-orange.svg)](#-supported-distributions)

**The tiniest self-hosted PaaS for your Raspberry Pi (and any Linux box)**
Deploy, manage, edit and back up web apps from your browser.
No Docker required: apps run as native processes, supervised by Pi-PaaS.

---

## 🔀 Two Editions, one code

|  | **Standalone** | **Docker Edition** |
| --- | --- | --- |
| **Apps run as** | Native processes (optionally as an unprivileged user) | One Docker container each |
| **Install** | `sudo bash install.sh` | `docker compose up -d` |
| **Needs Docker** | No | Yes |
| **Best for** | A Raspberry Pi, light setups | Stronger isolation between apps |

Both editions are the same code: the Docker Edition is container mode (`PIPAAS_RUNTIME=docker`). A project with its own `Dockerfile` uses it; otherwise Pi-PaaS writes one for its type. The `docker` branch follows `main`.

---

## ✨ Features

**Deploy**
* 🚀 Upload a `.zip` or a single `.html`, deploy a **git repository** (redeployed on every push through a signed webhook), or start from a **template**
* 💻 `pipaas deploy ./my-app` from your computer, with the one-file command-line client
* 🔌 **9 app types**: static, Node.js, Python/Flask, React/Vue/Vite, PHP, Deno, Bun, programs (Go, Rust…), Docker
* ↩️ **Previous versions** kept on every update; a failed build puts the old one back by itself; roll back in one click

**Run**
* 🌐 **App addresses without ports**: `http://blog.local` on your network, `blog.example.com` with automatic HTTPS (Let's Encrypt)
* 📈 **CPU and memory per app** with one-hour charts, **health checks** that can restart an app that stops answering
* 🧮 **Resource limits** per app (memory, CPU, priority)
* ⏰ **Scheduled tasks** per app (cron)
* ♻️ **Crash recovery** with backoff; an app that keeps crashing is parked
* 🔔 **Alerts** to ntfy, Telegram, a webhook or your phone (web push): crashes, apps not answering, failed deploys and backups, hot CPU, full disk, new versions

**Data**
* 🗃️ **SQLite or PostgreSQL** per app (each PostgreSQL app has its own login), with an **SQL console**
* 💽 A `DATA_DIR` folder per app that survives updates
* 💾 **Backups** checked after they are made, scheduled, and **copied off the Pi** (NAS folder or rclone: S3, Backblaze, Drive…), **encrypted** if you like
* 📋 **Live logs** with search

**Panel**
* 🔐 **Users and roles** (viewer, operator, admin), **two-step login**, **API tokens**
* 📂 Code editor, file manager, environment variables, custom start command
* 🌡️ CPU temperature, load, memory and disk at a glance; the port range drawn as the Pi's pin header
* 📱 **Installable on your phone**, light and dark theme, 6 languages (English, Italiano, Español, Français, Deutsch, 日本語)
* ⬆️ **Updates itself** from GitHub releases
* 📴 Works offline: nothing is loaded from the internet

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

### Docker Edition

```bash
git clone https://github.com/HexLions/pi-paas.git
cd pi-paas
sudo mkdir -p /srv/pi-paas-data
docker compose up -d
docker compose logs pi-paas | grep -i password   # the first password
```

The data folder must have the same path inside and outside the container (Docker mounts app volumes by host path); `docker-compose.yml` uses `/srv/pi-paas-data`.

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
├── backend/                  server.js (entry), http.js and routes/ (API), apps.js, processes.js,
│                             runtimes.js, build.js, sources.js, proxy.js, monitor.js, backups.js …
├── frontend/                 index.html, app.js, extras.js, i18n.js, style.css, sw.js
├── templates/                the template catalogue
├── cli/pipaas.js             the command-line client
├── Dockerfile, docker-compose.yml   Docker Edition
└── install.sh

~/pi-paas-data/             ← Your data (never touched by updates)
├── apps/<id>/                app code
├── releases/<id>/            previous versions of the code
├── volumes/<id>/             persistent data (DATA_DIR, SQLite)
├── backups/<id>/             .tar.gz backups and their check results
├── logs/<id>.log             app logs (rotated at 5 MB)
├── certs/                    HTTPS certificates
├── registry.json             apps (mode 600)
├── auth.json                 users, password hashes, API token hashes (mode 600)
├── settings.json             panel settings (mode 600)
└── push.json                 push keys and subscribed browsers (mode 600)
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

### From git

Choose **Git repository** in the deploy dialog: the URL, the branch, a token for private repositories and, for a monorepo, the folder. In the app's **Settings** you find a webhook address and secret: add them to GitHub, Gitea or GitLab and every push to the branch deploys the new code.

### From your computer

```bash
curl -o pipaas http://<pi>:9000/cli/pipaas.js && chmod +x pipaas
./pipaas login http://<pi>:9000        # paste an API token from Settings › API tokens
./pipaas deploy ./my-app               # creates or updates the app, then follows the build
./pipaas logs my-app -f
./pipaas rollback my-app 3
```

`.env` files, `node_modules`, `venv` and `.git` are left out of the upload.

---

## 🌐 App addresses

When the panel runs as root, its built-in proxy listens on ports 80 and 443:

* `http://<app>.local` works on your network: Pi-PaaS answers the mDNS questions for app names;
* with a base domain in **Settings › Network** (a wildcard DNS record pointing at the Pi), every app gets `<app>.<domain>` and the panel `panel.<domain>`;
* each app can have its own domains (**app Settings › Addresses**);
* with an e-mail set, public names get Let's Encrypt certificates, renewed by themselves, and http redirects to https.

Already running nginx or another web server on port 80? Install with `--nginx`, or set `PIPAAS_PROXY_PORT=off`.

---

## 📈 Monitoring and alerts

* Each app row shows its CPU and memory; **More › Usage** opens one-hour charts.
* The health check calls the app every 30 seconds (path configurable) and can restart it after 3 failures.
* **Settings › Notifications**: ntfy, Telegram, a webhook, and push on this device (the panel must be opened over HTTPS for push). Choose which events are sent and the temperature and disk limits.
* `GET /api/summary` gives the machine and every app in one call, for dashboards (a HexDeck widget uses it).

---

## 💾 Backups

* **Manual**: "Create backup now"
* **Scheduled**: daily (3:00) or weekly (Sunday 3:00)
* **Contents**: app files (without `node_modules`/`venv`), the data volume, the PostgreSQL dump, metadata
* **Restore**: stops the app, restores files, data and database, reinstalls dependencies, starts it again
* **Rotation**: keeps the last 5 per app (`PIPAAS_MAX_BACKUPS`)
* **Checked**: every backup is read back right after it is made
* **Off the Pi**: **Settings › Backups** copies each backup to a folder (a mounted NAS or USB disk) or an rclone remote, encrypted with your passphrase if you set one; restore from the remote copy in the app's Backups dialog

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
| `PIPAAS_RUNTIME` | *(native)* | `docker`: every app in its own container (Docker Edition) |
| `PIPAAS_PROXY_PORT` | `80` as root, else off | Built-in proxy port, or `off` |
| `PIPAAS_HTTPS_PORT` | `443` as root, else off | HTTPS port of the proxy, or `off` |
| `PIPAAS_KEEP_RELEASES` | `3` | Previous versions kept per app |
| `PIPAAS_UPDATE_REPO` | `HexLions/pi-paas` | Where the panel looks for new versions |

Forgot a password, or lost the phone with the 2FA app? On the server:

```bash
node ~/pi-paas/backend/cli.js set-password admin
node ~/pi-paas/backend/cli.js reset-2fa admin
node ~/pi-paas/backend/cli.js users
sudo systemctl restart pi-paas
```

---

## 🔄 Updating

```bash
cd ~/pi-paas
git pull origin main
sudo bash install.sh     # your data in ~/pi-paas-data/ is preserved
```

Or from the panel: **Settings › Updates** checks GitHub every day and installs a new release with one click.

Upgrading from v1.1: your password becomes the `admin` user. Upgrading from v1.0: the registry is migrated automatically, existing apps keep running, and you are asked for a panel password (or one is generated).

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
* Apps share the app user with each other. They are kept away from the panel and the system, not from each other. Use the Docker Edition to separate them.
* Give people the lowest role that does the job, and turn on two-step login for admins.
* Webhooks are checked with their secret; API tokens are stored only as hashes and never have more rights than their owner.
* PostgreSQL passwords are stored in `registry.json` (mode 600) and only shown in the database dialog of their app.

---

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md).

## 🤝 Contributing

Contributions, issues and feature requests are welcome! Check the [issues page](https://github.com/HexLions/pi-paas/issues). Please run `npm test` before opening a pull request.

## 📄 License

Licensed under the **GNU General Public License v3.0**, see [LICENSE](LICENSE).

Made with ❤️ by [HexLions](https://github.com/HexLions)
