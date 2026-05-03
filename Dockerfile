FROM node:20-alpine

LABEL maintainer="HexLions"
LABEL description="Pi-PaaS Docker Edition — Self-hosted PaaS panel"
LABEL version="2.0.0"

# Install docker CLI (to talk to host Docker socket)
RUN apk add --no-cache \
    docker-cli \
    curl \
    bash \
    git \
    python3 \
    py3-pip \
    nginx \
    openssl

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY templates/ ./templates/

# Data directory (mounted as volume in production)
RUN mkdir -p /data/apps /data/logs /data/uploads

# Nginx config for proxying apps
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:9000/api/health || exit 1

CMD ["node", "backend/server.js"]
