[![Pi-PaaS](assets/banner.svg)](assets/banner.svg)

[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/HexLions/pi-paas/actions/workflows/ci.yml/badge.svg)](https://github.com/HexLions/pi-paas/actions/workflows/ci.yml)
[![Image](https://github.com/HexLions/pi-paas/actions/workflows/image.yml/badge.svg)](https://github.com/HexLions/pi-paas/pkgs/container/pi-paas)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-Debian%20%7C%20Fedora%20%7C%20Arch%20%7C%20Alpine%20%7C%20SUSE%20%7C%20Docker-orange.svg)](#-supported-systems)

**The tiniest self-hosted PaaS for your Raspberry Pi (and any Linux box)**
Deploy web apps from a ZIP, a git repository or your terminal, give them real addresses with HTTPS, watch them, back them up off the Pi, and get an alert on your phone when one falls over. All from a panel that works offline.

---

## Contents

- [Features](#-features)
- [Two editions, one code](#-two-editions-one-code)
- [Install: Standalone](#-install-standalone)
- [Install: Docker Edition](#-install-docker-edition)
- [Install with Portainer](#-install-with-portainer)
- [First steps](#-first-steps)
- [Deploying apps](#-deploying-apps)
- [App addresses and HTTPS](#-app-addresses-and-https)
- [Monitoring and alerts](#-monitoring-and-alerts)
- [Backups](#-backups)
- [Users, roles and API tokens](#-users-roles-and-api-tokens)
- [Configuration](#-configuration)
- [Updating](#-updating)
- [Service management and recovery](#-service-management-and-recovery)
- [Layout](#-layout)
- [API](#-api)
- [Development](#-development)
- [Security notes](#-security-notes)

---

## ✨ Features

**Deploy**
* 🚀 Upload a `.zip` or a single `.html`, deploy a **git repository** (redeployed on every push through a signed webhook), or start from a **template**
* 💻 `pipaas deploy ./my-app` from your computer, with the one-file command-line client
* 🔌 **9 app types**: static, Node.js, Python/Flask, React/Vue/Vite, PHP, Deno, Bun, programs (Go, Rust…), Docker
* ↩️ **Previous versions** kept on every update; a failed build puts the old one back by itself; roll back in one click

**Run**
* 🌐 **Addresses without ports**: `http://blog.local` on your network, `blog.example.com` with automatic HTTPS (Let's Encrypt)
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
* ⬆️ **Updates itself** from GitHub releases (Standalone)
* 📴 Works offline: nothing is loaded from the internet

---

## 🔀 Two editions, one code

|  | **Standalone** | **Docker Edition** |
| --- | --- | --- |
| **Apps run as** | Native processes (by default as the unprivileged user `pipaas-apps`) | One Docker container each |
| **Install** | `sudo bash install.sh` | `docker compose up -d`, or a Portainer stack |
| **Needs Docker** | No | Yes |
| **Best for** | A Raspberry Pi, light setups | Stronger isolation between apps, hosts already run with Docker |
| **Updates** | From the panel, or `git pull` + installer | Pull the new image |

Both are the same code: the Docker Edition is container mode (`PIPAAS_RUNTIME=docker`). In it, a project with its own `Dockerfile` uses it; any other project gets a Dockerfile written for its type, from the official multi-arch images (so it builds on a Pi). The `docker` branch follows `main`.

---

## 🐧 Install: Standalone

```bash
git clone https://github.com/HexLions/pi-paas.git
cd pi-paas
sudo bash install.sh
# → http://<your-ip>:9000   user: admin
```

The installer asks you to choose the `admin` password. If you skip it, a random one is generated, printed at the end, and saved in `~/pi-paas-data/initial-password.txt` until you change it from the panel.

| Option | Meaning |
| --- | --- |
| `--port N` | Panel port (default `9000`) |
| `--no-postgres` | Do not install PostgreSQL (SQLite still works) |
| `--nginx` | Keep port 80 for nginx: writes a snippet publishing the panel at `/pi-paas/` and turns the built-in proxy off |
| `--app-user NAME` | Run apps and builds as this unprivileged user (created if missing) |
| `--no-app-user` | Run apps as the panel user |
| `--password PW` | Set the `admin` password without being asked |
| `-y`, `--yes` | Do not ask questions |
| `--uninstall` | Remove the service and code, keep your data |

On a **new install as root**, apps run as the unprivileged user `pipaas-apps`, so an uploaded app cannot read the panel's files or the system's. Upgrades keep their previous behaviour unless you pass `--app-user`.

### Supported systems

| Family | Distributions |
| --- | --- |
| **Debian** | Debian, Ubuntu, DietPi, Raspberry Pi OS, Linux Mint, Pop!_OS, Kali, Zorin, elementary |
| **Fedora** | Fedora, CentOS, Rocky Linux, AlmaLinux, RHEL |
| **Arch** | Arch Linux, Manjaro, EndeavourOS, Garuda |
| **Alpine** | Alpine Linux (OpenRC) |
| **SUSE** | openSUSE Leap, openSUSE Tumbleweed, SLES |

Node.js 18 or newer is installed if missing (22 LTS). The SQL console for SQLite needs Node 22.5 or newer.

---

## 🐳 Install: Docker Edition

The image `ghcr.io/hexlions/pi-paas` is built for `amd64`, `arm64` (Raspberry Pi 3/4/5 with a 64-bit OS) and `arm/v7` (32-bit Raspberry Pi OS).

```bash
sudo mkdir -p /srv/pi-paas-data
curl -O https://raw.githubusercontent.com/HexLions/pi-paas/main/docker-compose.yml
docker compose up -d
docker compose logs pi-paas | grep -i password    # the first admin password
# → http://<your-ip>:9000   user: admin
```

Three things in `docker-compose.yml` matter and must stay as they are:

* **`network_mode: host`**: apps listen on the host's ports, and the built-in proxy (80/443) and the `.local` names work as in the Standalone Edition.
* **`/var/run/docker.sock`**: Pi-PaaS starts one container per app (named `pipaas-<app>`) through it. Anything that can use the socket controls the host: keep the panel's login strong.
* **`/srv/pi-paas-data:/srv/pi-paas-data`**: the data folder must have **the same path inside and outside** the container, because Docker mounts each app's data folder by its host path. Use another path if you like, but the same one on both sides and in `PIPAAS_DATA_DIR`.

Without internet access to GitHub's registry, `docker compose up -d --build` builds the image from the source instead.

---

## 🧭 Install with Portainer

Portainer runs the Docker Edition as a stack.

> ⚠️ Portainer itself uses port **9000** (HTTP) and **9443**. Give Pi-PaaS another port, for example **9100**, with `PIPAAS_PORT`. If a reverse proxy (Nginx Proxy Manager, Traefik, Caddy…) already holds ports 80 and 443, turn Pi-PaaS's own proxy off with `PIPAAS_PROXY_PORT` and `PIPAAS_HTTPS_PORT` set to `off`.

1. On the host, create the data folder once: `sudo mkdir -p /srv/pi-paas-data`.
2. In Portainer: **Stacks › Add stack**, name it `pi-paas`, choose **Web editor**, and paste:

   ```yaml
   services:
     pi-paas:
       image: ghcr.io/hexlions/pi-paas:latest
       container_name: pi-paas
       restart: unless-stopped
       network_mode: host
       volumes:
         - /var/run/docker.sock:/var/run/docker.sock
         - /srv/pi-paas-data:/srv/pi-paas-data
       environment:
         PIPAAS_RUNTIME: docker
         PIPAAS_DATA_DIR: /srv/pi-paas-data
         PIPAAS_PORT: "9100"
         PIPAAS_PASSWORD: choose-a-long-password   # first admin password; change it in the panel later
         # PIPAAS_PROXY_PORT: "off"                # if ports 80/443 are taken
         # PIPAAS_HTTPS_PORT: "off"
   ```

   Instead of the web editor you can choose **Repository**: URL `https://github.com/HexLions/pi-paas`, reference `refs/heads/main`, compose path `docker-compose.yml`, and add the same environment variables in the stack's **Environment variables** section.
3. **Deploy the stack**, then open `http://<host>:9100` and log in as `admin` with the password you set. Without `PIPAAS_PASSWORD`, read the generated one in **Containers › pi-paas › Logs**.
4. **Updating**: **Stacks › pi-paas › Editor › Update the stack** with **Re-pull image** turned on. Your apps and data stay in `/srv/pi-paas-data`.

The containers Pi-PaaS creates for apps (`pipaas-<app>`) show up in Portainer too. Manage them from Pi-PaaS: it recreates them on every deploy, restart and update, so changes made to them in Portainer do not last.

---

## 👣 First steps

1. Log in as `admin`. If the password was generated, a banner asks you to change it.
2. **Settings › Account**: turn on **two-step login**, and on your phone **Notifications on this device** (needs HTTPS).
3. **Deploy app**: drop a `.zip` or `.html` anywhere on the page, or pick **Git repository** or **Template**.
4. **Settings › Network**: set a domain and an e-mail for HTTPS, if the Pi is reachable from the internet.
5. **Settings › Backups**: copy backups to your NAS, and set a passphrase.
6. **Settings › Users**: give family or colleagues their own login with the role they need.

---

## 📱 Deploying apps

Every app gets these environment variables:

| Variable | Description |
| --- | --- |
| `PORT` | Assigned port (3001–3200). Your app must listen on it, on `0.0.0.0`. |
| `DATA_DIR` | Folder that survives updates; put uploads and data files here (`/data` in the Docker Edition) |
| `DATABASE_URL` | Database connection string (`sqlite:/…` or `postgresql://user:pass@localhost:5432/db`) |
| `SQLITE_PATH` | Path to the `.db` file (SQLite only) |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | PostgreSQL connection (PostgreSQL only) |
| `PIPAAS_APP_ID` | The app's id |

Add your own variables in the app's **Settings**. Apps do **not** inherit the panel's environment.

| Type | What Pi-PaaS does |
| --- | --- |
| **Static** | Serves the files (single-page apps work: unknown paths get `index.html`) |
| **Node.js** | `npm ci`/`npm install --omit=dev`, then `npm start`, or `server.js`, `app.js`, `index.js`, `main.js` |
| **Python / Flask** | A `venv` with `requirements.txt`, then `server.py`, `main.py`, `app.py` or `wsgi.py`. For gunicorn set a start command: `venv/bin/gunicorn -b 0.0.0.0:$PORT app:app` |
| **React / Vue / Vite** | `npm install` and `npm run build`, then serves `dist/`, `build/` or `out/` |
| **PHP** | PHP's built-in server on `public/` (or the top folder); `composer install` when Composer is there |
| **Deno** | `deno task start`, or `main.ts`/`server.ts` with network access and read/write only in its own folders |
| **Bun** | `bun install`, then `bun run start` or `index.ts`/`server.ts` |
| **Program** | A binary built for the Pi (Go, Rust…) named `app`, `server` or `main`, or any start command |
| **Docker** | Builds the project's `Dockerfile` and runs it with the host network |

PHP, Deno, Bun and Docker must be installed on the machine for their apps (the deploy dialog marks missing ones). In the Docker Edition every type works, inside its own container.

```js
// Node.js
app.listen(process.env.PORT || 3000, '0.0.0.0');
```
```python
# Python
app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 3000)))
```

### From git

Choose **Git repository** in the deploy dialog: the URL (https or ssh), the branch, a token for private repositories and, for a monorepo, the folder. In the app's **Settings** you find a webhook address and secret: add them to GitHub or Gitea (content type `application/json`) or GitLab (secret token), and every push to the branch deploys the new code. **More › Pull and deploy** does the same by hand.

### From your computer

```bash
curl -o pipaas http://<pi>:9000/cli/pipaas.js && chmod +x pipaas
./pipaas login http://<pi>:9000        # paste an API token from Settings › API tokens
./pipaas deploy ./my-app               # creates or updates the app, then follows the build
./pipaas apps                          # list with state, port and address
./pipaas logs my-app -f
./pipaas restart my-app
./pipaas rollback my-app               # lists the kept versions; add one to roll back
```

The CLI needs Node 18 or newer and nothing else. `.env` files, `node_modules`, `venv` and `.git` are left out of the upload (`--include-env` sends `.env`).

### Templates

**Deploy app › Template**: a link hub for your home network, a personal page, a Notes API (Node, no dependencies), Flask with SQLite and a PHP guestbook.

### Versions and rollback

Every update keeps the code it replaced (3 versions, `PIPAAS_KEEP_RELEASES`). **More › Previous versions** rolls back in one click; data, databases and settings stay as they are. A failed build never replaces the running version.

---

## 🌐 App addresses and HTTPS

When the panel runs as root (the default for both editions), its built-in proxy listens on ports 80 and 443:

* `http://<app>.local` works on your network: Pi-PaaS answers the mDNS questions for app names, next to the system's own avahi;
* with a base domain in **Settings › Network** (a wildcard DNS record such as `*.pi.example.com` pointing at the Pi), every app gets `<app>.<domain>` and the panel `panel.<domain>`;
* each app can have its own domains in its **Settings › Addresses**;
* with an e-mail set, public names get Let's Encrypt certificates (ports 80 and 443 reachable from the internet), renewed by themselves, and http redirects to https.

The machine's own name and IP address on port 80 open the panel. Ports 80/443 taken by another web server? Install with `--nginx`, or set `PIPAAS_PROXY_PORT=off` and `PIPAAS_HTTPS_PORT=off`.

---

## 📈 Monitoring and alerts

* Each app row shows its CPU and memory; **More › Usage** opens one-hour charts (also as a table).
* The health check calls the app every 30 seconds (path configurable) and can restart it after 3 failures.
* **More › Scheduled tasks** runs commands on a cron schedule with the app's variables; output goes to the log.
* **Settings › Notifications**: ntfy, Telegram, a webhook, and push to the panel installed on your phone. Choose which events are sent and the temperature and disk limits. **Settings › Activity** lists the latest events.
* `GET /api/summary` gives the machine and every app in one call, for dashboards (a HexDeck widget uses it).

---

## 💾 Backups

* **Manual** or **scheduled** (daily at 3:00, or Sundays at 3:00)
* **Contents**: app files (without `node_modules`/`venv`), the data folder, the PostgreSQL dump, metadata
* **Checked**: every backup is read back right after it is made
* **Off the Pi**: **Settings › Backups** copies each backup to a folder (a mounted NAS or USB disk) or an rclone remote (S3, Backblaze B2, Google Drive, SFTP… set up with `rclone config` first), encrypted with your passphrase if you set one
* **Restore**: stops the app, restores files, data and database, reinstalls dependencies, starts it again; from a local backup or from the copy off the Pi
* **Rotation**: the last 5 per app, here and off the Pi (`PIPAAS_MAX_BACKUPS`)

Keep the passphrase somewhere safe: encrypted copies cannot be restored without it.

---

## 👥 Users, roles and API tokens

| Role | Can |
| --- | --- |
| **viewer** | See apps, logs, usage and activity |
| **operator** | Also deploy, update, start, stop and roll back apps, edit files, settings, tasks and backups, read the database |
| **admin** | Also manage users, tokens of everyone, panel settings and updates, delete apps, change data in the SQL console |

* **Two-step login** (TOTP) with any authenticator app; each code works once.
* **API tokens** (**Settings › API tokens**) for the CLI, scripts and dashboards, sent as `Authorization: Bearer pp_…`. A token never has more rights than its owner, and only its hash is stored.

---

## 🔧 Configuration

The installer writes these into the service file; in Docker set them in the compose file or the Portainer stack.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIPAAS_PORT` | `9000` | Panel port |
| `PIPAAS_HOST` | `0.0.0.0` | Panel listen address |
| `PIPAAS_DATA_DIR` | `~/pi-paas-data` | Data folder (Docker: the same path inside and outside) |
| `PIPAAS_RUNTIME` | *(native)* | `docker`: every app in its own container (Docker Edition) |
| `PIPAAS_PORT_RANGE` | `3001-3200` | Ports handed out to apps |
| `PIPAAS_PROXY_PORT` | `80` as root, else off | Built-in proxy port, or `off` |
| `PIPAAS_HTTPS_PORT` | `443` as root, else off | Its HTTPS port, or `off` |
| `PIPAAS_APP_USER` | *(empty)* | Run apps and builds as this user (the panel must run as root) |
| `PIPAAS_PUBLIC_HOST` | *(request host)* | Host name used in app links |
| `PIPAAS_PASSWORD` | *(empty)* | First `admin` password, used only when none is set yet |
| `PIPAAS_MAX_BACKUPS` | `5` | Backups kept per app |
| `PIPAAS_KEEP_RELEASES` | `3` | Previous versions kept per app |
| `PIPAAS_UPLOAD_LIMIT_MB` | `100` | Maximum upload size |
| `PIPAAS_BUILD_TIMEOUT` | `600` | Seconds allowed for install + build |
| `PIPAAS_MAX_LOG_MB` | `5` | Log size before rotation |
| `PIPAAS_UPDATE_REPO` | `HexLions/pi-paas` | Where the panel looks for new versions |
| `PIPAAS_AUTH` | *(on)* | `off` disables the login. Only behind your own authentication. |

Everything else (notifications, domains, certificates, offsite backups, update checks) is set in the panel and kept in `settings.json`.

---

## 🔄 Updating

**Standalone**: **Settings › Updates** checks GitHub every day and installs a new release with one click; the panel restarts, apps keep running. By hand:

```bash
cd ~/pi-paas
git pull origin main
sudo bash install.sh     # your data in ~/pi-paas-data/ is kept
```

**Docker Edition**: `docker compose pull && docker compose up -d`, or in Portainer update the stack with **Re-pull image**.

Upgrading from 1.1: your password becomes the `admin` user. From 1.0: the registry is migrated automatically and existing apps keep running.

---

## 🛠️ Service management and recovery

```bash
sudo systemctl status pi-paas          # Alpine: rc-service pi-paas status
sudo systemctl restart pi-paas
journalctl -u pi-paas -f               # Alpine: /var/log/pi-paas.log; Docker: docker logs -f pi-paas
```

Forgot a password, or lost the phone with the 2FA app? On the machine:

```bash
node ~/pi-paas/backend/cli.js set-password admin
node ~/pi-paas/backend/cli.js reset-2fa admin
node ~/pi-paas/backend/cli.js add-user anna operator
node ~/pi-paas/backend/cli.js users
```

In the Docker Edition run the same commands inside the container, for example `docker exec -it pi-paas node backend/cli.js set-password admin`.

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

## 🔌 API

Everything the panel does goes through its JSON API under `/api`. With an API token:

```bash
curl -H "Authorization: Bearer pp_…" http://<pi>:9000/api/summary
curl -H "Authorization: Bearer pp_…" http://<pi>:9000/api/apps
curl -X POST -H "Authorization: Bearer pp_…" http://<pi>:9000/api/apps/blog/restart
```

Requests made with the panel's session cookie must also send the header `X-PiPaaS: 1`; requests with a token do not need it.

---

## 🧑‍💻 Development

```bash
npm install
npm run dev      # panel on :9000, data in ./.dev-data, user admin / devpassword
npm test         # unit and API tests with real HTTP and real child processes
npm run lint     # syntax check + shellcheck
```

Tests need Node 18+, `tar` and `git`; no root, Docker, PostgreSQL or Python.

---

## 🔒 Security notes

* The panel runs code on your machine: that is its job. Keep it on your LAN or behind a VPN, use a strong password and two-step login.
* In the Standalone Edition apps share the app user: they are kept away from the panel and the system, not from each other. The Docker Edition separates them; its panel controls Docker through the socket, which equals root on the host.
* Give people the lowest role that does the job.
* Webhooks are checked with their secret; API tokens are stored only as hashes; PostgreSQL passwords are stored in `registry.json` (mode 600) and only shown in the database dialog of their app.
* Code from git or a backup may not carry links pointing outside the app, and ZIP files are checked against path tricks before they are unpacked.

Found a problem? Please open an issue, or write to the maintainers for anything sensitive.

---

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md).

## 🤝 Contributing

Contributions, issues and feature requests are welcome! Check the [issues page](https://github.com/HexLions/pi-paas/issues). Please run `npm test` before opening a pull request.

## 📄 License

Licensed under the **GNU General Public License v3.0**, see [LICENSE](LICENSE).

Made with ❤️ by [HexLions](https://github.com/HexLions)
