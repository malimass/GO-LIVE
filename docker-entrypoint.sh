#!/bin/sh

# Generate proxychains config from SOCKS5_PROXY env var
if [ -n "$SOCKS5_PROXY" ]; then
  # Parse socks5://host:port
  PROXY_HOST=$(echo "$SOCKS5_PROXY" | sed 's|socks5://||' | cut -d: -f1)
  PROXY_PORT=$(echo "$SOCKS5_PROXY" | sed 's|socks5://||' | cut -d: -f2)

  cat > /app/proxychains.conf << EOF
strict_chain
quiet_mode
proxy_dns
tcp_read_time_out 15000
tcp_connect_time_out 8000

[ProxyList]
socks5 $PROXY_HOST $PROXY_PORT
EOF

  echo "Proxychains configured: $PROXY_HOST:$PROXY_PORT"
fi

exec node dist/index.js
