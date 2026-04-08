#!/bin/sh

# Set up SSH tunnel for FB proxy if configured
if [ -n "$FB_PROXY_HOST" ] && [ -f /app/.ssh/id_rsa ]; then
  echo "Setting up SSH tunnel to $FB_PROXY_HOST for Facebook proxy..."
  ssh -f -N -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -i /app/.ssh/id_rsa \
    -L 127.0.0.1:1443:live-api-s.facebook.com:443 \
    root@"$FB_PROXY_HOST"
  echo "SSH tunnel established on localhost:1443"
fi

exec node dist/index.js
