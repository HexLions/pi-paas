# 🐳 Pi-PaaS Docker Edition
> Fork of [Pi-PaaS](https://github.com/HexLions/pi-paas) — Docker-powered backend instead of native processes.

[![Version](https://img.shields.io/badge/version-2.0.0-blue)]()
[![Mode](https://img.shields.io/badge/mode-docker-2496ED?logo=docker)]()
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)]()

---

## Differences from Pi-PaaS Standalone

| Feature | Standalone (`main`) | Docker (`docker`) |
|---------|--------------------|--------------------|
| App isolation | OS processes | Docker containers |
| Portability | Linux only | Any Docker host |
| Requirements | Node.js, nginx | Docker Engine |
| App start | `npm start` / `python` | `docker build + run` |
| Log access | File-based | `docker logs` |
| Resource limits | None | Via Docker |

---

## Requirements

- Docker Engine 24+
- Docker Compose v2
- Any Linux/macOS/Windows host (ARM or x86)

---

## Quick Start

```bash
git clone https://github.com/HexLions/pi-paas.git
cd pi-paas
git checkout docker
docker compose up -d
```

Panel available at: **http://localhost:9000**

---

## How it works

Pi-PaaS mounts the host Docker socket (`/var/run/docker.sock`) and uses the **Docker Engine API** to:

1. **Deploy** → builds a Docker image from the app's source
2. **Start** → creates and starts a container with the assigned port
3. **Stop** → stops the container (files preserved)
4. **Delete** → removes container + image + files
5. **Logs** → streams from `docker logs`

Each app gets its own container with a **generated `Dockerfile`** if none is provided.

### Auto-generated Dockerfiles by runtime

| Detected by | Runtime | Base image |
|-------------|---------|------------|
| `package.json` | Node.js | `node:20-alpine` |
| `package.json` + `build` script | Node.js (build) | `node:20-alpine` |
| `requirements.txt` / `app.py` | Python | `python:3.11-alpine` |
| `index.html` only | Static | `nginx:alpine` |
| Custom `Dockerfile` in project | Custom | — |

---

## Data persistence

All app files and registry data are stored in a named Docker volume:

```
pi-paas-data (Docker volume)
├── apps/          ← App source files
├── logs/          ← (legacy, logs now via docker logs)
├── uploads/       ← Temp uploads
├── backups/       ← Zip backups
└── registry.json  ← App registry
```

To back up all your data:

```bash
docker run --rm -v pi-paas-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/pi-paas-backup.tar.gz /data
```

---

## Configuration

Edit `docker-compose.yml` environment variables:

```yaml
environment:
  - PANEL_PORT=9000             # Pi-PaaS panel port
  - PORT_RANGE_START=3001       # First app port
  - PORT_RANGE_END=3200         # Last app port
  - DOCKER_NETWORK=pi-paas-net  # Internal Docker network
```

---

## Updating

```bash
git pull origin docker
docker compose up -d --build
```

Your app data (in the Docker volume) is never touched.

---

## Branch structure

```
main    ← Pi-PaaS Standalone (native processes, no Docker required)
docker  ← Pi-PaaS Docker Edition (this branch)
```

---

## License

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](https://github.com/HexLions/pi-paas/blob/main/LICENSE) file for details.

This means you are free to use, modify and distribute this software, but any derivative work must also be released under GPL-3.0 with source code available.

GPL-3.0 © [HexLions](https://github.com/HexLions)
