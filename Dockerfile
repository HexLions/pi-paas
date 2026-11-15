# Pi-PaaS, Docker Edition: the panel in a container, every app in its own
# container started through the host's Docker socket.
FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-buildx git tar curl

WORKDIR /opt/pi-paas
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY backend ./backend
COPY frontend ./frontend
COPY assets ./assets
COPY templates ./templates
COPY cli ./cli

ENV NODE_ENV=production \
    PIPAAS_RUNTIME=docker \
    PIPAAS_DATA_DIR=/srv/pi-paas-data

EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PIPAAS_PORT:-9000}/api/health || exit 1

CMD ["node", "backend/server.js"]
