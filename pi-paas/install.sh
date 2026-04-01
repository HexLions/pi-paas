#!/bin/bash
# ============================================================
#  Pi-PaaS Installer
#  Multi-distro: Debian/Ubuntu/DietPi/RPi OS/Fedora/CentOS/
#                Arch/Alpine/openSUSE
# ============================================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

SERVICE_NAME="pi-paas"

# --- Detect user & home ---
if [ "$EUID" -eq 0 ]; then
  INSTALL_USER="root"
  HOME_DIR="/root"
else
  INSTALL_USER="$(whoami)"
  HOME_DIR="$HOME"
fi

INSTALL_DIR="${HOME_DIR}/pi-paas"
DATA_DIR="${HOME_DIR}/pi-paas-data"

echo -e "${CYAN}"
cat << 'LOGO'

  ██████╗ ██╗      ██████╗  █████╗  █████╗ ███████╗
  ██╔══██╗██║      ██╔══██╗██╔══██╗██╔══██╗██╔════╝
  ██████╔╝██║█████╗██████╔╝███████║███████║███████╗
  ██╔═══╝ ██║╚════╝██╔═══╝ ██╔══██║██╔══██║╚════██║
  ██║     ██║      ██║     ██║  ██║██║  ██║███████║
  ╚═╝     ╚═╝      ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝

LOGO
echo -e "${NC}"
echo -e "  ${BLUE}Mini Platform-as-a-Service${NC}"
echo -e "  User: ${GREEN}${INSTALL_USER}${NC} | Home: ${GREEN}${HOME_DIR}${NC}"
echo ""

# --- Detect Linux distribution ---
detect_distro() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO_ID="${ID}"
    DISTRO_NAME="${PRETTY_NAME}"
    DISTRO_FAMILY=""

    case "$ID" in
      debian|ubuntu|raspbian|linuxmint|pop|dietpi|neon|elementary|zorin|kali)
        DISTRO_FAMILY="debian"
        ;;
      fedora|rhel|centos|rocky|alma|oracle|nobara)
        DISTRO_FAMILY="fedora"
        ;;
      arch|manjaro|endeavouros|garuda|artix)
        DISTRO_FAMILY="arch"
        ;;
      alpine)
        DISTRO_FAMILY="alpine"
        ;;
      opensuse*|sles)
        DISTRO_FAMILY="suse"
        ;;
      *)
        # Try ID_LIKE as fallback
        case "$ID_LIKE" in
          *debian*|*ubuntu*) DISTRO_FAMILY="debian" ;;
          *fedora*|*rhel*)   DISTRO_FAMILY="fedora" ;;
          *arch*)            DISTRO_FAMILY="arch" ;;
          *suse*)            DISTRO_FAMILY="suse" ;;
          *)                 DISTRO_FAMILY="unknown" ;;
        esac
        ;;
    esac
  else
    DISTRO_ID="unknown"
    DISTRO_NAME="Unknown Linux"
    DISTRO_FAMILY="unknown"
  fi

  echo -e "  Distro: ${GREEN}${DISTRO_NAME}${NC} (family: ${BLUE}${DISTRO_FAMILY}${NC})"
}

detect_distro

if [ "$DISTRO_FAMILY" = "unknown" ]; then
  echo -e "${YELLOW}⚠  Distribuzione non riconosciuta: ${DISTRO_ID}${NC}"
  echo "  L'installer supporta: Debian, Ubuntu, Fedora, CentOS, Arch, Alpine, openSUSE"
  echo "  e derivate. Puoi provare a continuare (potrebbe non funzionare)."
  read -p "  Continuare? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
fi

# --- Helper: run as root ---
run_root() {
  if [ "$EUID" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# --- Step 1: Install system dependencies ---
echo -e "\n${GREEN}[1/6]${NC} Installazione dipendenze di sistema..."

install_deps_debian() {
  run_root apt-get update -qq
  run_root apt-get install -y -qq unzip nginx postgresql postgresql-client python3 python3-venv python3-pip curl
}

install_deps_fedora() {
  run_root dnf install -y -q unzip nginx postgresql-server postgresql python3 python3-pip curl
  # Init postgres if needed
  if [ ! -d /var/lib/pgsql/data ] || [ -z "$(ls -A /var/lib/pgsql/data 2>/dev/null)" ]; then
    run_root postgresql-setup --initdb 2>/dev/null || true
  fi
}

install_deps_arch() {
  run_root pacman -Sy --noconfirm --needed unzip nginx postgresql python python-pip curl
  # Init postgres if needed
  if [ ! -d /var/lib/postgres/data ] || [ -z "$(ls -A /var/lib/postgres/data 2>/dev/null)" ]; then
    run_root su - postgres -c "initdb -D /var/lib/postgres/data" 2>/dev/null || true
  fi
}

install_deps_alpine() {
  run_root apk update
  run_root apk add unzip nginx postgresql postgresql-client python3 py3-pip curl nodejs npm
}

install_deps_suse() {
  run_root zypper -n install unzip nginx postgresql-server postgresql python3 python3-pip curl
}

case "$DISTRO_FAMILY" in
  debian)  install_deps_debian ;;
  fedora)  install_deps_fedora ;;
  arch)    install_deps_arch ;;
  alpine)  install_deps_alpine ;;
  suse)    install_deps_suse ;;
  *)       echo -e "${YELLOW}Tentativo con apt-get...${NC}"; install_deps_debian ;;
esac

# --- Step 2: Install Node.js ---
echo -e "${GREEN}[2/6]${NC} Verifica Node.js..."
if ! command -v node &> /dev/null; then
  echo "  Installazione Node.js..."
  case "$DISTRO_FAMILY" in
    debian)
      curl -fsSL https://deb.nodesource.com/setup_20.x | run_root bash -
      run_root apt-get install -y -qq nodejs
      ;;
    fedora)
      run_root dnf install -y -q nodejs
      ;;
    arch)
      run_root pacman -S --noconfirm nodejs npm
      ;;
    alpine)
      # Already installed above
      ;;
    suse)
      run_root zypper -n install nodejs20 npm20 || run_root zypper -n install nodejs npm
      ;;
    *)
      curl -fsSL https://deb.nodesource.com/setup_20.x | run_root bash -
      run_root apt-get install -y -qq nodejs
      ;;
  esac
fi
NODE_V=$(node --version 2>/dev/null || echo "not found")
echo -e "  Node.js ${BLUE}${NODE_V}${NC} ✓"

# --- Step 3: Setup PostgreSQL ---
echo -e "${GREEN}[3/6]${NC} Configurazione PostgreSQL..."

# Enable and start PostgreSQL
if command -v systemctl &> /dev/null; then
  run_root systemctl enable postgresql --quiet 2>/dev/null || true
  run_root systemctl start postgresql 2>/dev/null || true
elif command -v rc-service &> /dev/null; then
  # Alpine uses OpenRC
  run_root rc-service postgresql start 2>/dev/null || true
  run_root rc-update add postgresql default 2>/dev/null || true
fi

# Create pi-paas role
run_root su -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='pipaas'\"" postgres 2>/dev/null | grep -q 1 || \
  run_root su -c "psql -c \"CREATE ROLE pipaas WITH LOGIN CREATEDB PASSWORD 'pipaas';\"" postgres 2>/dev/null || true
echo "  PostgreSQL configurato ✓"

# --- Step 4: Setup project ---
echo -e "${GREEN}[4/6]${NC} Installazione Pi-PaaS..."

# Data directory (separate from code)
mkdir -p "$DATA_DIR"/{apps,logs,uploads}
echo -e "  Directory dati: ${BLUE}${DATA_DIR}${NC} ✓"

# Migrate old data if exists
if [ -d "$INSTALL_DIR/apps" ] && [ "$(ls -A "$INSTALL_DIR/apps" 2>/dev/null)" ]; then
  echo -e "  ${YELLOW}Migrazione app dalla vecchia posizione...${NC}"
  cp -rn "$INSTALL_DIR/apps/"* "$DATA_DIR/apps/" 2>/dev/null || true
  [ -f "$INSTALL_DIR/data/registry.json" ] && cp -n "$INSTALL_DIR/data/registry.json" "$DATA_DIR/" 2>/dev/null || true
  cp -rn "$INSTALL_DIR/data/logs/"* "$DATA_DIR/logs/" 2>/dev/null || true
  echo "  Migrazione completata ✓"
fi

# Code directory
mkdir -p "$INSTALL_DIR"/{backend,frontend}

# Copy files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  if [ -f "$SCRIPT_DIR/backend/server.js" ]; then
    cp "$SCRIPT_DIR/backend/server.js" "$INSTALL_DIR/backend/"
    cp "$SCRIPT_DIR/frontend/index.html" "$INSTALL_DIR/frontend/"
    cp "$SCRIPT_DIR/frontend/i18n.js" "$INSTALL_DIR/frontend/" 2>/dev/null || true
    cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
  else
    echo -e "${RED}File sorgente non trovati in ${SCRIPT_DIR}${NC}"
    exit 1
  fi
else
  echo "  File già in posizione ✓"
fi

# Update DATA_DIR path in server.js to match actual home
sed -i "s|/root/pi-paas-data|${DATA_DIR}|g" "$INSTALL_DIR/backend/server.js"

cd "$INSTALL_DIR"
npm install --production 2>&1 | tail -1
echo "  Dipendenze npm installate ✓"

# Install 'serve' globally for static apps
run_root npm install -g serve --silent 2>/dev/null || true

# --- Step 5: Create service ---
echo -e "${GREEN}[5/6]${NC} Configurazione servizio..."

if command -v systemctl &> /dev/null; then
  # systemd
  run_root tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=Pi-PaaS - Mini Platform as a Service
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=${INSTALL_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) ${INSTALL_DIR}/backend/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  run_root systemctl daemon-reload
  run_root systemctl enable ${SERVICE_NAME} --quiet
  run_root systemctl restart ${SERVICE_NAME}
  echo "  Servizio systemd configurato ✓"

elif command -v rc-service &> /dev/null; then
  # OpenRC (Alpine)
  run_root tee /etc/init.d/${SERVICE_NAME} > /dev/null <<EOF
#!/sbin/openrc-run
name="Pi-PaaS"
description="Mini Platform as a Service"
command="$(which node)"
command_args="${INSTALL_DIR}/backend/server.js"
command_user="${INSTALL_USER}"
pidfile="/run/${SERVICE_NAME}.pid"
command_background=true
directory="${INSTALL_DIR}"

depend() {
  need net postgresql
}
EOF
  run_root chmod +x /etc/init.d/${SERVICE_NAME}
  run_root rc-update add ${SERVICE_NAME} default 2>/dev/null || true
  run_root rc-service ${SERVICE_NAME} restart 2>/dev/null || true
  echo "  Servizio OpenRC configurato ✓"
fi

# --- Step 6: Configure nginx ---
echo -e "${GREEN}[6/6]${NC} Configurazione nginx..."

NGINX_CONF_DIR="/etc/nginx"
[ -d "/etc/nginx/sites-available" ] && NGINX_STYLE="sites" || NGINX_STYLE="conf.d"

if [ "$NGINX_STYLE" = "sites" ]; then
  run_root tee /etc/nginx/sites-available/pi-paas > /dev/null <<'NGINX'
server {
    listen 80;
    server_name _;

    location /pi-paas/ {
        proxy_pass http://127.0.0.1:9000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 100M;
    }

    location /pi-paas/api/ {
        proxy_pass http://127.0.0.1:9000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 100M;
    }
}
NGINX
  run_root ln -sf /etc/nginx/sites-available/pi-paas /etc/nginx/sites-enabled/
else
  # Fedora/Arch/Alpine/SUSE use conf.d
  run_root tee /etc/nginx/conf.d/pi-paas.conf > /dev/null <<'NGINX'
server {
    listen 8080;
    server_name _;

    location /pi-paas/ {
        proxy_pass http://127.0.0.1:9000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 100M;
    }

    location /pi-paas/api/ {
        proxy_pass http://127.0.0.1:9000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 100M;
    }
}
NGINX
fi

run_root nginx -t 2>/dev/null && {
  if command -v systemctl &> /dev/null; then
    run_root systemctl enable nginx --quiet 2>/dev/null || true
    run_root systemctl reload nginx 2>/dev/null || run_root systemctl restart nginx
  elif command -v rc-service &> /dev/null; then
    run_root rc-service nginx restart 2>/dev/null || true
  fi
}

# --- Done! ---
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              ✅  Pi-PaaS installed!                      ║${NC}"
echo -e "${GREEN}╟──────────────────────────────────────────────────────────╢${NC}"
echo -e "${GREEN}║${NC}  Panel:     ${BLUE}http://${IP}:9000${NC}"
echo -e "${GREEN}║${NC}  Distro:    ${CYAN}${DISTRO_NAME}${NC}"
echo -e "${GREEN}║${NC}                                                          ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Code:      ${INSTALL_DIR}/              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Data:      ${DATA_DIR}/          ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  App ports: 3001-3200                                    ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                          ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Service:   systemctl status pi-paas                     ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Logs:      journalctl -u pi-paas -f                     ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
