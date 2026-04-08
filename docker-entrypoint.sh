#!/bin/sh

# Install ffmpeg on FB_PROXY_HOST if configured (for remote relay)
if [ -n "$FB_PROXY_HOST" ]; then
  SSH_KEY=""
  for k in /app/.ssh/id_ed25519 /app/.ssh/id_rsa; do
    [ -f "$k" ] && SSH_KEY="$k" && break
  done
  if [ -n "$SSH_KEY" ]; then
    echo "Checking ffmpeg on $FB_PROXY_HOST..."
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i "$SSH_KEY" \
      root@"$FB_PROXY_HOST" "ffmpeg -version 2>/dev/null | head -1 || echo 'WARNING: ffmpeg not found on proxy host'" 2>/dev/null
    echo "FB proxy remote relay ready: $FB_PROXY_HOST"
  fi
fi

exec node dist/index.js
