#!/bin/bash
set -e

# ============================================
#  GO-LIVE — Setup automatico Oracle Cloud
#  Esegui: bash setup.sh
# ============================================

echo ""
echo "=========================================="
echo "  GO-LIVE Setup — Oracle Cloud"
echo "=========================================="
echo ""

# 1. Chiedi configurazione
read -p "DuckDNS subdomain (es. golive-malimass): " DUCKDNS_SUB
read -p "DuckDNS token (da duckdns.org): " DUCKDNS_TOKEN
read -p "Email per SSL (es. massimo.malivindi@gmail.com): " SSL_EMAIL
read -sp "Password dashboard: " DASH_PASS
echo ""
read -p "RTMP ingest key (segreto per la camera): " RTMP_KEY

DOMAIN="${DUCKDNS_SUB}.duckdns.org"

echo ""
echo "→ Dominio: ${DOMAIN}"
echo "→ Dashboard: https://${DOMAIN}"
echo "→ RTMP: rtmp://${DOMAIN}:1935/live/${RTMP_KEY}"
echo ""

# 2. Installa Docker (se non presente)
if ! command -v docker &> /dev/null; then
    echo "→ Installazione Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
    echo "→ Docker installato. Potrebbe servire logout/login per i permessi."
fi

if ! command -v docker compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "→ Installazione Docker Compose plugin..."
    sudo apt-get update && sudo apt-get install -y docker-compose-plugin
fi

# 3. Clona repo
if [ ! -d "GO-LIVE" ]; then
    echo "→ Clonazione repository..."
    git clone https://github.com/malimass/GO-LIVE.git
fi

cd GO-LIVE

# 4. Genera encryption key
ENC_KEY=$(openssl rand -hex 32)

# 5. Crea .env
echo "→ Creazione .env..."
cat > .env << ENVEOF
# RTMP
RTMP_INGEST_KEY=${RTMP_KEY}
RTMP_PORT=1935

# Encryption (auto-generata)
ENCRYPTION_KEY=${ENC_KEY}

# Dashboard
DASHBOARD_PASSWORD=${DASH_PASS}
PORT=3000

# DuckDNS
DUCKDNS_SUBDOMAIN=${DUCKDNS_SUB}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN}

# Facebook (compila con le tue stream key)
FB_PAGE_1_RTMP_URL=rtmps://live-api-s.facebook.com:443/rtmp/
FB_PAGE_1_STREAM_KEY=
FB_PAGE_2_RTMP_URL=rtmps://live-api-s.facebook.com:443/rtmp/
FB_PAGE_2_STREAM_KEY=
FB_PAGE_3_RTMP_URL=rtmps://live-api-s.facebook.com:443/rtmp/
FB_PAGE_3_STREAM_KEY=

# Instagram (carica i cookie dalla dashboard)
IG_ACCOUNT_1_USERNAME=
IG_ACCOUNT_1_COOKIES_ENC=
IG_ACCOUNT_2_USERNAME=
IG_ACCOUNT_2_COOKIES_ENC=
IG_ACCOUNT_3_USERNAME=
IG_ACCOUNT_3_COOKIES_ENC=

NODE_ENV=production
ENVEOF

# 6. Configura Nginx con il dominio
echo "→ Configurazione Nginx SSL per ${DOMAIN}..."
sed -i "s/DOMAIN/${DOMAIN}/g" nginx/nginx.conf

# 7. Apri porte firewall Oracle
echo "→ Apertura porte firewall..."
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
sudo iptables -I INPUT -p tcp --dport 1935 -j ACCEPT 2>/dev/null || true
sudo iptables-save | sudo tee /etc/iptables/rules.v4 > /dev/null 2>/dev/null || true

# 8. Avvia DuckDNS per registrare IP
echo "→ Registrazione DuckDNS..."
curl -s "https://www.duckdns.org/update?domains=${DUCKDNS_SUB}&token=${DUCKDNS_TOKEN}&ip=" | head -1

# 9. Ottieni certificato SSL
echo "→ Ottenimento certificato SSL..."
mkdir -p nginx/ssl

# Prima avvia nginx senza SSL per la challenge
cat > nginx/nginx-temp.conf << 'TMPEOF'
events { worker_connections 1024; }
http {
    server {
        listen 80;
        location /.well-known/acme-challenge/ { root /var/www/certbot; }
        location / { return 200 'ok'; }
    }
}
TMPEOF

docker run -d --name temp-nginx -p 80:80 \
    -v $(pwd)/nginx/nginx-temp.conf:/etc/nginx/nginx.conf:ro \
    -v $(pwd)/certbot-webroot:/var/www/certbot \
    nginx:alpine

sleep 3

# Ottieni certificato
mkdir -p certbot-webroot
docker run --rm \
    -v $(pwd)/nginx/ssl:/etc/letsencrypt \
    -v $(pwd)/certbot-webroot:/var/www/certbot \
    certbot/certbot certonly \
    --webroot -w /var/www/certbot \
    -d "${DOMAIN}" \
    --email "${SSL_EMAIL}" \
    --agree-tos --non-interactive

# Ferma nginx temporaneo
docker rm -f temp-nginx
rm nginx/nginx-temp.conf

# 10. Build e avvia tutto
echo "→ Build e avvio GO-LIVE..."
docker compose up -d --build

echo ""
echo "=========================================="
echo "  GO-LIVE ATTIVO!"
echo "=========================================="
echo ""
echo "  Dashboard:  https://${DOMAIN}"
echo "  RTMP Input: rtmp://${DOMAIN}:1935/live/${RTMP_KEY}"
echo ""
echo "  Password dashboard: (quella che hai scelto)"
echo "  Encryption key salvata in .env"
echo ""
echo "  PROSSIMI PASSI:"
echo "  1. Apri https://${DOMAIN} e accedi"
echo "  2. Configura le stream key Facebook nel .env"
echo "  3. Carica i cookie Instagram dalla dashboard"
echo "  4. Sulla DJI: RTMP → rtmp://${DOMAIN}:1935/live/${RTMP_KEY}"
echo ""
echo "  Comandi utili:"
echo "  docker compose logs -f go-live    # Vedi log"
echo "  docker compose restart go-live    # Riavvia"
echo "  docker compose down               # Ferma tutto"
echo "  docker compose up -d --build      # Rebuild e avvia"
echo ""
