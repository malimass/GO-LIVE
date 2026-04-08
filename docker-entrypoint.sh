#!/bin/sh

# Set up SSH tunnel for FB proxy if configured
SSH_KEY=""
for k in /app/.ssh/id_ed25519 /app/.ssh/id_rsa; do
  [ -f "$k" ] && SSH_KEY="$k" && break
done
if [ -n "$FB_PROXY_HOST" ] && [ -n "$SSH_KEY" ]; then
  echo "Setting up SSH tunnel to $FB_PROXY_HOST for Facebook proxy..."
  ssh -f -N -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -i "$SSH_KEY" \
    -L 127.0.0.1:1443:live-api-s.facebook.com:443 \
    root@"$FB_PROXY_HOST"
  echo "SSH tunnel established on localhost:1443"
fi

exec node dist/index.js
