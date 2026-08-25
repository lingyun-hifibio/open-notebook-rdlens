# Single source of truth for both published image variants:
#   - regular (multi-container, SurrealDB external): default build / --target runtime
#   - single-container (app + SurrealDB):            --target single
# Shared stages below guarantee that fixes (tiktoken pre-cache, env defaults,
# npm retry logic, ...) apply to both variants at once.

# Stage 1: Frontend builder
FROM node:22-slim AS frontend-builder
WORKDIR /app/frontend

# Copy dependency files first to leverage cache
COPY frontend/package.json frontend/package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm config set registry ${NPM_REGISTRY} \
 && npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000
# Retry npm ci to survive transient registry ECONNRESETs, which are common on
# the QEMU-emulated arm64 leg of the multi-arch build.
RUN i=0; until npm ci; do \
      i=$((i+1)); \
      if [ "$i" -ge 5 ]; then echo "npm ci failed after $i attempts"; exit 1; fi; \
      echo "npm ci failed (attempt $i); retrying in 15s"; sleep 15; \
    done

# Copy the rest of the frontend source and build
COPY frontend/ ./
# RDLens embedded 部署构建参数（Issue #102）：NEXT_PUBLIC_RD_* 由 Next.js 构建时内联；
# RD_FRAME_ANCESTORS 由 next.config headers() build 时求值固化进 routes-manifest.json；
# 运行时 env 变更无效，须重建。默认空 = 上游默认行为。
ARG NEXT_PUBLIC_RD_EMBEDDED_MODE=""
ARG NEXT_PUBLIC_RD_GATEWAY_URL=""
ARG NEXT_PUBLIC_RD_PARENT_ORIGIN=""
ARG RD_FRAME_ANCESTORS=""
ENV NEXT_PUBLIC_RD_EMBEDDED_MODE=${NEXT_PUBLIC_RD_EMBEDDED_MODE} \
    NEXT_PUBLIC_RD_GATEWAY_URL=${NEXT_PUBLIC_RD_GATEWAY_URL} \
    NEXT_PUBLIC_RD_PARENT_ORIGIN=${NEXT_PUBLIC_RD_PARENT_ORIGIN} \
    RD_FRAME_ANCESTORS=${RD_FRAME_ANCESTORS}
RUN npm run build

# Stage 2: Backend builder
FROM python:3.12-slim-trixie AS backend-builder

# Install build dependencies (uv downloads pre-built wheels for most packages)
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install uv using the official method
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Set build optimization environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV UV_HTTP_TIMEOUT=120

# Copy dependency files and minimal package structure first for better layer caching
COPY pyproject.toml uv.lock ./
COPY open_notebook/__init__.py ./open_notebook/__init__.py

# Install dependencies (this layer is cached unless dependencies change)
RUN uv sync --frozen --no-dev

# Pre-download tiktoken encoding so the app works offline (issue #264).
# /app/tiktoken-cache is intentionally outside /app/data/ so that volume mounts
# of /app/data (for user data persistence) do not hide the pre-baked encoding.
# config.py reads TIKTOKEN_CACHE_DIR from the environment to pick up this path.
ENV TIKTOKEN_CACHE_DIR=/app/tiktoken-cache
RUN mkdir -p /app/tiktoken-cache && \
    .venv/bin/python -c "import tiktoken; tiktoken.get_encoding('o200k_base')"

# Stage 3: SurrealDB binary (pinned to v2 to match docker-compose.yml; used by the single target only)
FROM surrealdb/surrealdb:v2 AS surreal-binary

# Stage 4: Shared runtime base (everything common to both variants)
FROM python:3.12-slim-trixie AS runtime-base

# Install only runtime system dependencies (no build tools)
# Add Node.js 22.x LTS for running the frontend
# NOTE (issue #147): curl/libcurl must NOT remain in the final image — its only
# in-image consumer was scripts/wait-for-api.sh, now rewritten with python3
# urllib, and it carries 6 Critical CVEs (CVE-2026-8924/8926/8927/9079/10536/
# 11856, no fixed version in Debian trixie at remediation time). But the
# nodesource bootstrap script itself needs curl, so install curl first, run the
# bootstrap, then purge curl+libcurl4t64 (libcurl4t64 has no other reverse
# dependency in this image).
# npm 10.9.9 bundles tar ^7.5.22 (>= 7.5.19), closing the GHSA-23hp-3jrh-7fpw
# Critical that ships in the default nodesource npm 10.9.8 (tar 7.5.11).
# issue #147 layer0.3: npm 10.9.9's own transitive deps carry fixable Highs —
# brace-expansion 2.0.2 (GHSA-3jxr/mh99/rgw5), picomatch 4.0.3
# (GHSA-c2c7-rcm5-vvqj), ip-address 10.1.0 (GHSA-mwp4-54f8-5fhr), undici
# 6.26.0 (GHSA-vxpw-j846-p89q), tar 7.5.19 (GHSA-r292-9mhp-454m, fix 7.5.21),
# sigstore 3.1.0 (GHSA-52v5-jr5w-gjxr, fix 4.1.1). npm cannot upgrade its own
# bundled tree in place, so overlay the fixed versions from a scratch install
# (verified: npm --version + npm install still work).
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    ffmpeg \
    supervisor \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g npm@10.9.9 \
    && mkdir -p /tmp/npmfix && cd /tmp/npmfix \
    && npm init -y >/dev/null 2>&1 \
    && npm install --no-audit --no-fund --silent brace-expansion@2.1.4 picomatch@4.0.4 ip-address@10.3.1 undici@6.27.0 tar@7.5.21 sigstore@4.1.1 \
    && for p in brace-expansion picomatch ip-address undici tar sigstore; do \
         rm -rf /usr/lib/node_modules/npm/node_modules/$p \
         && cp -r /tmp/npmfix/node_modules/$p /usr/lib/node_modules/npm/node_modules/$p; \
       done \
    && rm -rf /tmp/npmfix \
    && apt-get purge -y --auto-remove curl libcurl4t64 \
    && rm -rf /var/lib/apt/lists/*

# Install uv using the official method
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Copy the virtual environment from the backend builder
COPY --from=backend-builder /app/.venv /app/.venv

# issue #147: pytubefix -> nodejs-wheel-binaries bundles a full Node 24 + npm
# 11.17.0 inside the venv. Its bundled tree carries fixable vulns that npm
# cannot upgrade in place, so overlay fixed versions from a scratch install:
#   - tar 7.5.19 -> 7.5.21 (GHSA-r292-9mhp-454m; 7.5.16 -> 7.5.19 closed the
#     GHSA-23hp-3jrh-7fpw Critical in layer0)
#   - brace-expansion 5.0.6 -> 5.0.9 (GHSA-3jxr/mh99/rgw5)
#   - ip-address 10.2.0 -> 10.3.1 (GHSA-mwp4-54f8-5fhr)
#   - undici 6.26.0 -> 6.27.0 (GHSA-vxpw-j846-p89q)
# Dependency declarations of the fixed versions are compatible with npm
# 11.17.0's ranges (verified: wheel node v24.19.0 + npm-cli.js --version OK).
RUN mkdir -p /tmp/nwfix && cd /tmp/nwfix \
    && npm init -y >/dev/null 2>&1 \
    && npm install --no-audit --no-fund --silent brace-expansion@5.0.9 ip-address@10.3.1 undici@6.27.0 tar@7.5.21 \
    && for p in brace-expansion ip-address undici tar; do \
         rm -rf /app/.venv/lib/python3.12/site-packages/nodejs_wheel/lib/node_modules/npm/node_modules/$p \
         && cp -r /tmp/nwfix/node_modules/$p /app/.venv/lib/python3.12/site-packages/nodejs_wheel/lib/node_modules/npm/node_modules/$p; \
       done \
    && rm -rf /tmp/nwfix

# Copy the source code
COPY . /app

# Copy pre-downloaded tiktoken encoding from builder (outside /data/ — volume-mount safe)
COPY --from=backend-builder /app/tiktoken-cache /app/tiktoken-cache

# Copy built frontend from standalone output
COPY --from=frontend-builder /app/frontend/.next/standalone /app/frontend/
COPY --from=frontend-builder /app/frontend/.next/static /app/frontend/.next/static
COPY --from=frontend-builder /app/frontend/public /app/frontend/public
COPY --from=frontend-builder /app/frontend/start-server.js /app/frontend/start-server.js

# Ensure uv uses the existing venv without attempting network operations
ENV UV_NO_SYNC=1
ENV VIRTUAL_ENV=/app/.venv
# Point the app at the pre-baked tiktoken encoding (see open_notebook/config.py)
ENV TIKTOKEN_CACHE_DIR=/app/tiktoken-cache
# Bind the API to all interfaces (IPv4). Set API_HOST=:: for IPv6 dual-stack environments
ENV API_HOST=0.0.0.0

# Caches for the opt-in heavy extraction runtimes (Docling, Crawl4AI local).
# These live UNDER /app/data so the user's volume mount persists them across
# container restarts and upgrades: wheels (uv), the Chromium browser (playwright)
# and Docling's ML models (huggingface) are downloaded once, then reused.
# See scripts/docker-entrypoint.sh and docs/7-DEVELOPMENT/decisions/ADR-007-optin-runtimes.md.
ENV UV_CACHE_DIR=/app/data/.cache/uv
ENV PLAYWRIGHT_BROWSERS_PATH=/app/data/.cache/playwright
ENV HF_HOME=/app/data/.cache/huggingface

# Data directory (volume-mounted by users) and supervisor log directory
RUN mkdir -p /app/data /var/log/supervisor \
    && chmod +x /app/scripts/wait-for-api.sh /app/scripts/docker-entrypoint.sh

# Copy supervisord configuration (shared programs: api, worker, frontend)
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Expose ports for Frontend and API
EXPOSE 8502 5055

# Runtime API URL Configuration
# The API_URL environment variable can be set at container runtime to configure
# where the frontend should connect to the API. This allows the same Docker image
# to work in different deployment scenarios without rebuilding.
#
# If not set, the system will auto-detect based on incoming requests.
# Set API_URL when using reverse proxies or custom domains.
#
# Example: docker run -e API_URL=https://your-domain.com/api ...

# The entrypoint installs any opt-in heavy runtimes (Docling, Crawl4AI local)
# enabled via OPEN_NOTEBOOK_ENABLE_* before handing off to CMD (supervisord).
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]

# Stage 5: Single-container variant (adds SurrealDB on top of the shared runtime)
# Build with: docker build --target single .
FROM runtime-base AS single

# Install SurrealDB (copied from pinned v2 image to match docker-compose.yml)
COPY --from=surreal-binary /surreal /usr/local/bin/surreal

# SurrealDB data directory (volume-mounted by users)
RUN mkdir -p /mydata

# Enable the surrealdb program in supervisord (appended to the shared config)
RUN cat /app/supervisord.surrealdb.conf >> /etc/supervisor/conf.d/supervisord.conf

# Stage 6 (default): Regular multi-container image (SurrealDB runs externally).
# Kept last so a plain `docker build .` produces this variant.
FROM runtime-base AS runtime
