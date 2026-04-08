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
localnet 127.0.0.0/255.0.0.0
localnet 10.0.0.0/255.0.0.0
localnet 172.16.0.0/255.240.0.0
localnet 192.168.0.0/255.255.0.0
tcp_read_time_out 15000
tcp_connect_time_out 8000

[ProxyList]
socks5 $PROXY_HOST $PROXY_PORT
EOF

  echo "Proxychains configured: $PROXY_HOST:$PROXY_PORT"
fi

exec node dist/index.js
