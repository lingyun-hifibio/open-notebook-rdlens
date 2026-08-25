#!/bin/sh
# Wait for the API to be healthy before starting the frontend
# This prevents the "Unable to Connect to API Server" error during startup
# POSIX-compliant so it runs with /bin/sh (dash) in slim images
#
# Uses python3's urllib (always present in the venv image) instead of curl so
# the curl/libcurl packages can be removed from the runtime image (issue #147
# image vulnerability remediation: curl CVE-2026-8924/8926/8927/9079/10536/11856
# had no fixed version in Debian trixie at remediation time).

API_URL="${INTERNAL_API_URL:-http://localhost:5055}"
MAX_RETRIES=60
RETRY_INTERVAL=5
i=0

echo "Waiting for API to be ready at ${API_URL}/health..."

# Locate a python3 (venv python preferred, fall back to system python3)
PYTHON_BIN="${PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
    if [ -x /app/.venv/bin/python ]; then
        PYTHON_BIN=/app/.venv/bin/python
    elif command -v python3 >/dev/null 2>&1; then
        PYTHON_BIN=python3
    else
        echo "ERROR: no python3 found for health probe" >&2
        exit 1
    fi
fi

while [ $i -lt $MAX_RETRIES ]; do
    if "$PYTHON_BIN" - "$API_URL" <<'EOF'
import sys, urllib.request
try:
    urllib.request.urlopen(sys.argv[1] + "/health", timeout=5)
    sys.exit(0)
except Exception:
    sys.exit(1)
EOF
    then
        echo "API is ready! Starting frontend..."
        exit 0
    fi
    i=$((i + 1))
    echo "Attempt $i/$MAX_RETRIES: API not ready yet, waiting ${RETRY_INTERVAL}s..."
    sleep $RETRY_INTERVAL
done

echo "ERROR: API did not become ready within $((MAX_RETRIES * RETRY_INTERVAL)) seconds"
echo "Starting frontend anyway - users may see connection errors initially"
exit 0  # Exit 0 so frontend still starts (better than nothing)
