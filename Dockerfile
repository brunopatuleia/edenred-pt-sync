FROM node:20-alpine

# Install build dependencies for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++ dcron

WORKDIR /app

# Install package dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy application source
COPY sync.mjs ./

# Create data directory for persistence
RUN mkdir -p /app/data

# Setup entrypoint script
RUN cat <<'EOF' > /app/entrypoint.sh
#!/bin/sh
set -e

CRON_EXPR="${CRON_SCHEDULE:-0 */2 * * *}"

echo "🚀 Starting Edenred PT Sync container..."
echo "⏰ Scheduled cron: $CRON_EXPR"

# Run initial sync immediately on startup
node sync.mjs || true

# Setup crontab
echo "$CRON_EXPR cd /app && /usr/local/bin/node sync.mjs >> /proc/1/fd/1 2>&1" > /etc/crontabs/root

# Start cron in foreground
exec crond -f -l 2
EOF

RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
