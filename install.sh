#!/bin/bash
# ============================================
#  Pi-PaaS Installer for DietPi
#  Mini Platform-as-a-Service per Raspberry Pi
# ============================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

INSTALL_DIR="/root/pi-paas"
SERVICE_NAME="pi-paas"

echo -e "${BLUE}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║         🍰  Pi-PaaS Installer        ║"
echo "  ║   Mini PaaS per il tuo Raspberry Pi  ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

# --- Check environment ---
if [ ! -d "/root" ]; then
  echo -e "${RED}Errore: directory /root non trovata.${NC}"
  exit 1
fi

# --- Step 1: Install system dependencies ---
echo -e "\n${GREEN}[1/6]${NC} Installazione dipendenze di sistema..."
apt-get update -qq
apt-get install -y -qq unzip nginx postgresql postgresql-client python3 python3-venv python3-pip curl

# --- Step 2: Install Node.js (if not present) ---
echo -e "${GREEN}[2/6]${NC} Verifica Node.js..."
if ! command -v node &> /dev/null; then
  echo "  Installazione Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
NODE_V=$(node --version)
echo -e "  Node.js ${BLUE}${NODE_V}${NC} ✓"

# --- Step 3: Setup PostgreSQL ---
echo -e "${GREEN}[3/6]${NC} Configurazione PostgreSQL..."
systemctl enable postgresql --quiet 2>/dev/null || true
systemctl start postgresql 2>/dev/null || true

# Create a pi-paas role if not exists
su -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='pipaas'\"" postgres | grep -q 1 || \
  su -c "psql -c \"CREATE ROLE pipaas WITH LOGIN CREATEDB PASSWORD 'pipaas';\"" postgres 2>/dev/null || true
echo "  PostgreSQL configurato ✓"

# --- Step 4: Setup project ---
echo -e "${GREEN}[4/6]${NC} Installazione Pi-PaaS..."

# Data directory lives OUTSIDE pi-paas — never touched by updates
DATA_DIR="/root/pi-paas-data"
mkdir -p "$DATA_DIR"/{apps,logs,uploads}
echo "  Directory dati: ${BLUE}${DATA_DIR}${NC} ✓"

# Migrate old data if it exists inside pi-paas/
if [ -d "$INSTALL_DIR/apps" ] && [ "$(ls -A $INSTALL_DIR/apps 2>/dev/null)" ]; then
  echo -e "  ${YELLOW}Migrazione app dalla vecchia posizione...${NC}"
  cp -rn "$INSTALL_DIR/apps/"* "$DATA_DIR/apps/" 2>/dev/null || true
  [ -f "$INSTALL_DIR/data/registry.json" ] && cp -n "$INSTALL_DIR/data/registry.json" "$DATA_DIR/" 2>/dev/null || true
  cp -rn "$INSTALL_DIR/data/logs/"* "$DATA_DIR/logs/" 2>/dev/null || true
  echo "  Migrazione completata ✓"
fi

# Pi-PaaS code directory
mkdir -p "$INSTALL_DIR"/{backend,frontend}

# Copy files only if running from a different directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  if [ -f "$SCRIPT_DIR/backend/server.js" ]; then
    cp "$SCRIPT_DIR/backend/server.js" "$INSTALL_DIR/backend/"
    cp "$SCRIPT_DIR/frontend/index.html" "$INSTALL_DIR/frontend/"
    cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
  else
    echo -e "${YELLOW}  File sorgente non trovati nella directory corrente.${NC}"
    echo "  Assicurati di eseguire lo script dalla directory pi-paas."
    exit 1
  fi
else
  echo "  File già in posizione ✓"
fi

cd "$INSTALL_DIR"
npm install --production 2>&1 | tail -1
echo "  Dipendenze npm installate ✓"

# Install 'serve' globally for static apps
npm install -g serve --silent 2>/dev/null || true

# --- Step 5: Create systemd service ---
echo -e "${GREEN}[5/6]${NC} Configurazione servizio systemd..."
tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=Pi-PaaS - Mini Platform as a Service
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) ${INSTALL_DIR}/backend/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pi-paas

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME} --quiet
systemctl restart ${SERVICE_NAME}

# --- Step 6: Configure nginx reverse proxy for panel ---
echo -e "${GREEN}[6/6]${NC} Configurazione nginx..."
tee /etc/nginx/sites-available/pi-paas > /dev/null <<'NGINX'
server {
    listen 80;
    server_name _;

    # Pi-PaaS Panel
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

    # API endpoints
    location /pi-paas/api/ {
        proxy_pass http://127.0.0.1:9000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 100M;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/pi-paas /etc/nginx/sites-enabled/
nginx -t 2>/dev/null && systemctl reload nginx

# --- Done! ---
IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║            ✅  Pi-PaaS installato!                   ║${NC}"
echo -e "${GREEN}╟──────────────────────────────────────────────────────╢${NC}"
echo -e "${GREEN}║${NC}  Pannello:    ${BLUE}http://${IP}:9000${NC}"
echo -e "${GREEN}║${NC}  Via nginx:   ${BLUE}http://${IP}/pi-paas/${NC}"
echo -e "${GREEN}║${NC}                                                      ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Codice:      /root/pi-paas/          (aggiornabile) ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Dati & App:  /root/pi-paas-data/     (intoccabile)  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                      ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Porte app: 3001-3200                                ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                      ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Gestione servizio:                                  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    systemctl status pi-paas                          ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    journalctl -u pi-paas -f                          ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
