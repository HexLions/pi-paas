#!/usr/bin/env bash
# ============================================================
#  Pi-PaaS installer
#  Debian / Ubuntu / DietPi / Raspberry Pi OS / Fedora / RHEL /
#  Arch / Alpine / openSUSE, with systemd or OpenRC.
#
#  bash install.sh [options]
#    --port N          panel port (default 9000)
#    --no-postgres     do not install PostgreSQL (SQLite still works)
#    --nginx           also publish the panel through nginx at /pi-paas/
#    --app-user NAME   run apps as this unprivileged user (created if missing)
#    --no-app-user     run apps as the panel user
#    --password PW     panel password (otherwise asked, or generated)
#    --uninstall       remove the service and code, keep the data
#    -y, --yes         do not ask questions
# ============================================================
set -euo pipefail

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
SERVICE_NAME="pi-paas"
PANEL_PORT=9000
WITH_POSTGRES=1
WITH_NGINX=0
APP_USER="__default__"
PASSWORD=""
UNINSTALL=0
ASSUME_YES=0
MIN_NODE_MAJOR=18

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PANEL_PORT="$2"; shift 2 ;;
    --no-postgres) WITH_POSTGRES=0; shift ;;
    --nginx) WITH_NGINX=1; shift ;;
    --app-user) APP_USER="$2"; shift 2 ;;
    --no-app-user) APP_USER=""; shift ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
  esac
done

if ! [[ "$PANEL_PORT" =~ ^[0-9]+$ ]] || [ "$PANEL_PORT" -lt 1 ] || [ "$PANEL_PORT" -gt 65535 ]; then
  echo -e "${RED}--port must be a number between 1 and 65535${NC}"; exit 1
fi

step() { echo -e "\n${GREEN}[$1]${NC} $2"; }
ok() { echo -e "  $1 ${GREEN}✓${NC}"; }
warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; }
die() { echo -e "${RED}✗ $1${NC}"; exit 1; }

run_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

if [ "$(id -u)" -eq 0 ]; then
  INSTALL_USER="root"
  HOME_DIR="/root"
else
  INSTALL_USER="$(id -un)"
  HOME_DIR="$HOME"
  command -v sudo >/dev/null || die "Run as root, or install sudo."
fi
INSTALL_DIR="${HOME_DIR}/pi-paas"
DATA_DIR="${HOME_DIR}/pi-paas-data"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then INIT=systemd
elif command -v rc-service >/dev/null 2>&1; then INIT=openrc
else INIT=none; fi

# ---------- uninstall ----------
if [ "$UNINSTALL" -eq 1 ]; then
  echo -e "${CYAN}Removing Pi-PaaS (your data in ${DATA_DIR} is kept)${NC}"
  if [ "$INIT" = systemd ]; then
    run_root systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
    run_root rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    run_root systemctl daemon-reload
  elif [ "$INIT" = openrc ]; then
    run_root rc-service "$SERVICE_NAME" stop 2>/dev/null || true
    run_root rc-update del "$SERVICE_NAME" default 2>/dev/null || true
    run_root rm -f "/etc/init.d/${SERVICE_NAME}"
  fi
  run_root rm -f /etc/nginx/sites-enabled/pi-paas /etc/nginx/sites-available/pi-paas /etc/nginx/conf.d/pi-paas.conf
  if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then rm -rf "$INSTALL_DIR"; fi
  ok "Removed. Delete ${DATA_DIR} yourself if you no longer need the apps and backups."
  exit 0
fi

echo -e "${CYAN}"
cat << 'LOGO'
   ____  _       ____             ____
  |  _ \(_)     |  _ \ __ _  __ _/ ___|
  | |_) | |_____| |_) / _` |/ _` \___ \
  |  __/| |_____|  __/ (_| | (_| |___) |
  |_|   |_|     |_|   \__,_|\__,_|____/
LOGO
echo -e "${NC}  The tiniest self-hosted PaaS for your Raspberry Pi"
echo -e "  User: ${GREEN}${INSTALL_USER}${NC}  Code: ${GREEN}${INSTALL_DIR}${NC}  Data: ${GREEN}${DATA_DIR}${NC}  Init: ${GREEN}${INIT}${NC}"

# ---------- distro ----------
DISTRO_FAMILY=unknown
DISTRO_NAME="Unknown Linux"
if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO_NAME="${PRETTY_NAME:-$ID}"
  case "${ID:-}" in
    debian|ubuntu|raspbian|linuxmint|pop|dietpi|neon|elementary|zorin|kali) DISTRO_FAMILY=debian ;;
    fedora|rhel|centos|rocky|almalinux|alma|ol|oracle|nobara) DISTRO_FAMILY=fedora ;;
    arch|manjaro|endeavouros|garuda|artix) DISTRO_FAMILY=arch ;;
    alpine) DISTRO_FAMILY=alpine ;;
    opensuse*|sles) DISTRO_FAMILY=suse ;;
    *)
      case "${ID_LIKE:-}" in
        *debian*|*ubuntu*) DISTRO_FAMILY=debian ;;
        *fedora*|*rhel*) DISTRO_FAMILY=fedora ;;
        *arch*) DISTRO_FAMILY=arch ;;
        *suse*) DISTRO_FAMILY=suse ;;
      esac ;;
  esac
fi
echo -e "  Distro: ${GREEN}${DISTRO_NAME}${NC} (${DISTRO_FAMILY})"
if [ "$DISTRO_FAMILY" = unknown ]; then
  warn "Unrecognised distribution. Supported: Debian, Ubuntu, Fedora, RHEL, Arch, Alpine, openSUSE and derivatives."
  if [ "$ASSUME_YES" -ne 1 ]; then
    read -r -p "  Continue anyway? (y/N) " reply
    [[ "$reply" =~ ^[Yy]$ ]] || exit 1
  fi
fi

FRESH_INSTALL=1
[ -f "${DATA_DIR}/registry.json" ] && FRESH_INSTALL=0
if [ "$APP_USER" = "__default__" ]; then
  # New root installs isolate apps by default. Upgrades keep their old behaviour
  # unless asked, because existing apps may write files owned by root.
  if [ "$INSTALL_USER" = root ] && [ "$FRESH_INSTALL" -eq 1 ]; then APP_USER="pipaas-apps"; else APP_USER=""; fi
fi
if [ -n "$APP_USER" ] && [ "$INSTALL_USER" != root ]; then
  warn "--app-user needs a root install; apps will run as ${INSTALL_USER}"
  APP_USER=""
fi

# ---------- 1. system packages ----------
step 1/6 "System packages"
PKGS_PG=""
case "$DISTRO_FAMILY" in
  debian)
    [ "$WITH_POSTGRES" -eq 1 ] && PKGS_PG="postgresql postgresql-client"
    run_root apt-get update -qq
    # shellcheck disable=SC2086
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl tar python3 python3-venv python3-pip $PKGS_PG
    [ "$WITH_NGINX" -eq 1 ] && run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx
    ;;
  fedora)
    [ "$WITH_POSTGRES" -eq 1 ] && PKGS_PG="postgresql-server postgresql"
    # shellcheck disable=SC2086
    run_root dnf install -y -q curl tar python3 python3-pip $PKGS_PG
    [ "$WITH_NGINX" -eq 1 ] && run_root dnf install -y -q nginx
    if [ "$WITH_POSTGRES" -eq 1 ] && [ -z "$(run_root ls -A /var/lib/pgsql/data 2>/dev/null)" ]; then
      run_root postgresql-setup --initdb >/dev/null 2>&1 || true
    fi
    ;;
  arch)
    [ "$WITH_POSTGRES" -eq 1 ] && PKGS_PG="postgresql"
    # shellcheck disable=SC2086
    run_root pacman -Sy --noconfirm --needed curl tar python python-pip $PKGS_PG
    [ "$WITH_NGINX" -eq 1 ] && run_root pacman -S --noconfirm --needed nginx
    if [ "$WITH_POSTGRES" -eq 1 ] && [ -z "$(run_root ls -A /var/lib/postgres/data 2>/dev/null)" ]; then
      run_root su - postgres -c "initdb -D /var/lib/postgres/data" >/dev/null 2>&1 || true
    fi
    ;;
  alpine)
    [ "$WITH_POSTGRES" -eq 1 ] && PKGS_PG="postgresql postgresql-client"
    run_root apk update -q
    # shellcheck disable=SC2086
    run_root apk add -q bash curl tar python3 py3-pip nodejs npm shadow util-linux $PKGS_PG
    [ "$WITH_NGINX" -eq 1 ] && run_root apk add -q nginx
    if [ "$WITH_POSTGRES" -eq 1 ] && [ -z "$(run_root ls -A /var/lib/postgresql/data 2>/dev/null)" ]; then
      run_root /etc/init.d/postgresql setup >/dev/null 2>&1 || true
    fi
    ;;
  suse)
    [ "$WITH_POSTGRES" -eq 1 ] && PKGS_PG="postgresql-server postgresql"
    # shellcheck disable=SC2086
    run_root zypper -n -q install curl tar python3 python3-pip $PKGS_PG
    [ "$WITH_NGINX" -eq 1 ] && run_root zypper -n -q install nginx
    ;;
  *)
    warn "Skipping package installation: install curl, tar, python3 (with venv) and Node.js ${MIN_NODE_MAJOR}+ yourself."
    ;;
esac
ok "Packages installed"

# ---------- 2. Node.js ----------
step 2/6 "Node.js"
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt "$MIN_NODE_MAJOR" ]; then
  echo "  Installing Node.js 22 LTS…"
  case "$DISTRO_FAMILY" in
    debian) curl -fsSL https://deb.nodesource.com/setup_22.x | run_root bash - >/dev/null; run_root apt-get install -y -qq nodejs ;;
    fedora) run_root dnf install -y -q nodejs npm ;;
    arch) run_root pacman -S --noconfirm --needed nodejs npm ;;
    alpine) run_root apk add -q nodejs npm ;;
    suse) run_root zypper -n -q install nodejs22 npm22 || run_root zypper -n -q install nodejs npm ;;
    *) die "Install Node.js ${MIN_NODE_MAJOR}+ and run the installer again." ;;
  esac
fi
[ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] || die "Node.js ${MIN_NODE_MAJOR}+ is required, found $(node --version 2>/dev/null || echo none)."
NODE_BIN="$(command -v node)"
ok "Node.js $(node --version)"

# ---------- 3. PostgreSQL ----------
step 3/6 "PostgreSQL"
if [ "$WITH_POSTGRES" -eq 1 ]; then
  if [ "$INIT" = systemd ]; then
    run_root systemctl enable --now postgresql >/dev/null 2>&1 || warn "Could not start PostgreSQL"
  elif [ "$INIT" = openrc ]; then
    run_root rc-update add postgresql default >/dev/null 2>&1 || true
    run_root rc-service postgresql start >/dev/null 2>&1 || warn "Could not start PostgreSQL"
  fi
  ok "PostgreSQL ready (each app gets its own database and login)"
else
  ok "Skipped (--no-postgres)"
fi

# ---------- 4. Pi-PaaS ----------
step 4/6 "Pi-PaaS"
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

# v1.0 kept apps inside the code folder; move them to the data folder once.
if [ -d "$INSTALL_DIR/apps" ] && [ -n "$(ls -A "$INSTALL_DIR/apps" 2>/dev/null)" ]; then
  warn "Moving apps from the old location into ${DATA_DIR}"
  mkdir -p "$DATA_DIR/apps" "$DATA_DIR/logs"
  cp -rn "$INSTALL_DIR/apps/." "$DATA_DIR/apps/" 2>/dev/null || true
  [ -f "$INSTALL_DIR/data/registry.json" ] && cp -n "$INSTALL_DIR/data/registry.json" "$DATA_DIR/" || true
  cp -rn "$INSTALL_DIR/data/logs/." "$DATA_DIR/logs/" 2>/dev/null || true
fi

if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  [ -f "$SCRIPT_DIR/backend/server.js" ] || die "Run install.sh from the Pi-PaaS folder (backend/server.js not found)."
  mkdir -p "$INSTALL_DIR"
  rm -rf "$INSTALL_DIR/backend" "$INSTALL_DIR/frontend" "$INSTALL_DIR/assets"
  (cd "$SCRIPT_DIR" && tar -cf - backend frontend assets package.json package-lock.json LICENSE README.md 2>/dev/null) | (cd "$INSTALL_DIR" && tar -xf -)
  ok "Code copied to ${INSTALL_DIR}"
else
  ok "Code already in place"
fi

cd "$INSTALL_DIR"
if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund --loglevel=error; else npm install --omit=dev --no-audit --no-fund --loglevel=error; fi
ok "npm dependencies installed"

if [ -n "$APP_USER" ]; then
  if ! id "$APP_USER" >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
      useradd --system --home-dir "$DATA_DIR/home" --no-create-home --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null \
        || useradd -r -d "$DATA_DIR/home" -M -s /sbin/nologin "$APP_USER"
    else
      adduser -S -D -H -h "$DATA_DIR/home" -s /sbin/nologin "$APP_USER"
    fi
  fi
  mkdir -p "$DATA_DIR/apps" "$DATA_DIR/volumes" "$DATA_DIR/home"
  # The panel (root) still owns the data folder; apps get their own folders.
  chmod 711 "$DATA_DIR"
  chown -R "$APP_USER": "$DATA_DIR/apps" "$DATA_DIR/volumes" "$DATA_DIR/home"
  ok "Apps run as the unprivileged user ${APP_USER}"
fi

# Panel password
export PIPAAS_DATA_DIR="$DATA_DIR"
if [ ! -f "$DATA_DIR/auth.json" ] || [ -n "$PASSWORD" ]; then
  if [ -z "$PASSWORD" ] && [ "$ASSUME_YES" -ne 1 ] && [ -t 0 ]; then
    read -r -s -p "  Choose a panel password (min. 8 characters, empty = generate one): " PASSWORD; echo
  fi
  if [ -n "$PASSWORD" ]; then
    printf '%s\n' "$PASSWORD" | "$NODE_BIN" "$INSTALL_DIR/backend/cli.js" set-password >/dev/null
    ok "Panel password set"
  fi
fi

# ---------- 5. service ----------
step 5/6 "Service"
ENV_LINES=(
  "PIPAAS_DATA_DIR=${DATA_DIR}"
  "PIPAAS_PORT=${PANEL_PORT}"
  "NODE_ENV=production"
)
[ -n "$APP_USER" ] && ENV_LINES+=("PIPAAS_APP_USER=${APP_USER}")
[ "$WITH_NGINX" -eq 1 ] && ENV_LINES+=("PIPAAS_TRUST_PROXY=1")

if [ "$INIT" = systemd ]; then
  {
    echo "[Unit]"
    echo "Description=Pi-PaaS - the tiniest self-hosted PaaS"
    echo "After=network-online.target postgresql.service"
    echo "Wants=network-online.target"
    echo
    echo "[Service]"
    echo "Type=simple"
    echo "User=${INSTALL_USER}"
    echo "WorkingDirectory=${INSTALL_DIR}"
    for l in "${ENV_LINES[@]}"; do echo "Environment=${l}"; done
    echo "ExecStart=${NODE_BIN} ${INSTALL_DIR}/backend/server.js"
    echo "Restart=always"
    echo "RestartSec=5"
    echo "TimeoutStopSec=30"
    echo "SyslogIdentifier=pi-paas"
    echo
    echo "[Install]"
    echo "WantedBy=multi-user.target"
  } | run_root tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null
  run_root systemctl daemon-reload
  run_root systemctl enable "$SERVICE_NAME" --quiet
  run_root systemctl restart "$SERVICE_NAME"
  ok "systemd service ${SERVICE_NAME}"
elif [ "$INIT" = openrc ]; then
  {
    echo "#!/sbin/openrc-run"
    echo "name=\"Pi-PaaS\""
    echo "description=\"The tiniest self-hosted PaaS\""
    for l in "${ENV_LINES[@]}"; do echo "export ${l}"; done
    echo "command=\"${NODE_BIN}\""
    echo "command_args=\"${INSTALL_DIR}/backend/server.js\""
    echo "command_user=\"${INSTALL_USER}\""
    echo "command_background=true"
    echo "pidfile=\"/run/${SERVICE_NAME}.pid\""
    echo "directory=\"${INSTALL_DIR}\""
    echo "output_log=\"/var/log/${SERVICE_NAME}.log\""
    echo "error_log=\"/var/log/${SERVICE_NAME}.log\""
    echo "retry=\"SIGTERM/30/SIGKILL/5\""
    echo
    echo "depend() {"
    echo "  need net"
    echo "  after postgresql"
    echo "}"
  } | run_root tee "/etc/init.d/${SERVICE_NAME}" >/dev/null
  run_root chmod +x "/etc/init.d/${SERVICE_NAME}"
  run_root rc-update add "$SERVICE_NAME" default >/dev/null 2>&1 || true
  run_root rc-service "$SERVICE_NAME" restart >/dev/null
  ok "OpenRC service ${SERVICE_NAME}"
else
  warn "No systemd or OpenRC found. Start it yourself with:"
  echo "    PIPAAS_DATA_DIR=${DATA_DIR} PIPAAS_PORT=${PANEL_PORT} node ${INSTALL_DIR}/backend/server.js"
fi

# ---------- 6. nginx (optional) ----------
step 6/6 "nginx"
if [ "$WITH_NGINX" -eq 1 ]; then
  read -r -d '' NGINX_SITE <<EOF || true
# Pi-PaaS panel at http://<host>/pi-paas/
location /pi-paas/ {
    proxy_pass http://127.0.0.1:${PANEL_PORT}/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 300s;
    client_max_body_size 100M;
}
EOF
  run_root mkdir -p /etc/nginx/snippets
  printf '%s\n' "$NGINX_SITE" | run_root tee /etc/nginx/snippets/pi-paas.conf >/dev/null
  ok "Wrote /etc/nginx/snippets/pi-paas.conf"
  echo "  Add this line inside the server { } block that should serve the panel:"
  echo -e "    ${CYAN}include /etc/nginx/snippets/pi-paas.conf;${NC}"
  echo "  then run: nginx -t && systemctl reload nginx"
else
  ok "Skipped (use --nginx to publish the panel under /pi-paas/)"
fi

# ---------- done ----------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="$(hostname)"
INITIAL_PW=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if run_root test -f "$DATA_DIR/initial-password.txt"; then INITIAL_PW="$(run_root cat "$DATA_DIR/initial-password.txt")"; break; fi
  if run_root test -f "$DATA_DIR/auth.json"; then break; fi
  sleep 1
done

echo
echo -e "${GREEN}✅ Pi-PaaS is installed${NC}"
echo -e "   Panel:     ${BLUE}http://${IP}:${PANEL_PORT}${NC}"
if [ -n "$INITIAL_PW" ]; then
  echo -e "   Password:  ${YELLOW}${INITIAL_PW}${NC}  (generated; change it from the panel)"
fi
echo    "   Code:      ${INSTALL_DIR}"
echo    "   Data:      ${DATA_DIR}  (apps, volumes, backups, logs - never touched by updates)"
echo    "   App ports: 3001-3200"
if [ "$INIT" = systemd ]; then
  echo  "   Service:   systemctl status ${SERVICE_NAME}   ·   journalctl -u ${SERVICE_NAME} -f"
elif [ "$INIT" = openrc ]; then
  echo  "   Service:   rc-service ${SERVICE_NAME} status   ·   tail -f /var/log/${SERVICE_NAME}.log"
fi
echo    "   Password:  node ${INSTALL_DIR}/backend/cli.js set-password   (to reset it)"
echo
