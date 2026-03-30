# GO-LIVE — Guida Setup Completa

## Architettura

```
DJI Osmo Action 4 (camper)
     │ RTMP
     ▼
Oracle Cloud VM (gratis, sempre attiva)
     │
     ├── RTMP Ingest (:1935) → riceve stream
     ├── Playwright → estrae 3 stream key Instagram
     ├── 6x FFmpeg → distribuisce a 6 destinazioni
     ├── Dashboard (:443) → monitora e configura
     └── DuckDNS → dominio gratis con HTTPS
           │
           ├── Facebook 1, 2, 3 (stream key permanenti)
           └── Instagram 1, 2, 3 (stream key via Playwright)
```

---

## Step 1: Oracle Cloud Free Tier

### Crea account
1. Vai su https://cloud.oracle.com/sign-up
2. Scegli region: **eu-frankfurt-1** (o la piu vicina a te)
3. Inserisci carta di credito (verifica, non addebita nulla)
4. Attendi attivazione (pochi minuti)

### Crea la VM
1. Vai su **Compute → Instances → Create Instance**
2. Configurazione:
   - **Name**: go-live
   - **Image**: Ubuntu 22.04 (o 24.04)
   - **Shape**: clicca "Change Shape"
     - Tipo: **Ampere** (ARM)
     - Shape: **VM.Standard.A1.Flex**
     - OCPU: **4** (gratis fino a 4)
     - RAM: **24 GB** (gratis fino a 24)
   - **Networking**: lascia default (crea VCN automatica)
   - **SSH Key**: clicca "Generate a key pair" → **SCARICA ENTRAMBE LE CHIAVI**
3. Clicca **Create**
4. Attendi stato **RUNNING**
5. Copia il **Public IP** (es. 140.238.xxx.xxx)

### Apri le porte
1. Nella pagina dell'istanza, clicca **Virtual Cloud Network** (link sotto "Primary VNIC")
2. Clicca sulla **Subnet** → **Security Lists** → **Default Security List**
3. Clicca **Add Ingress Rules** e aggiungi:

| Source CIDR | Protocol | Dest Port | Descrizione |
|---|---|---|---|
| 0.0.0.0/0 | TCP | 80 | HTTP |
| 0.0.0.0/0 | TCP | 443 | HTTPS |
| 0.0.0.0/0 | TCP | 1935 | RTMP |

---

## Step 2: DuckDNS

1. Vai su https://www.duckdns.org
2. Accedi con Google (usa massimo.malivindi@gmail.com)
3. Nel campo "sub domain", scrivi il nome che vuoi (es. `golive-malimass`)
4. Clicca **add domain**
5. Copia il **token** mostrato in alto nella pagina (stringa lunga)
6. Il dominio sara: `golive-malimass.duckdns.org`

---

## Step 3: Deploy sulla VM

### Connettiti via SSH

**Da Windows (PowerShell):**
```powershell
ssh -i C:\Users\HP\Downloads\ssh-key.key ubuntu@TUO_IP_ORACLE
```

Se da errore permessi sulla chiave:
```powershell
icacls "C:\Users\HP\Downloads\ssh-key.key" /inheritance:r /grant:r "%username%:R"
```

**Da Mac/Linux:**
```bash
chmod 400 ~/Downloads/ssh-key.key
ssh -i ~/Downloads/ssh-key.key ubuntu@TUO_IP_ORACLE
```

### Lancia setup automatico

Una volta connesso via SSH:
```bash
git clone https://github.com/malimass/GO-LIVE.git
cd GO-LIVE
bash setup.sh
```

Lo script ti chiedera:
- **DuckDNS subdomain**: es. `golive-malimass` (senza .duckdns.org)
- **DuckDNS token**: il token copiato prima
- **Email SSL**: `massimo.malivindi@gmail.com`
- **Password dashboard**: scegli una password sicura
- **RTMP ingest key**: scegli una chiave segreta per la camera

Poi fa tutto da solo: installa Docker, configura SSL, avvia tutto.

---

## Step 4: Configura Facebook

### Ottieni stream key permanenti
Per ogni pagina Facebook:
1. Vai su https://www.facebook.com/live/producer
2. Seleziona la pagina
3. Clicca **Usa chiave di streaming permanente**
4. Copia **URL del server** e **Chiave di streaming**

### Inserisci nel server
```bash
ssh -i chiave.key ubuntu@TUO_IP
cd GO-LIVE
nano .env
```

Compila:
```
FB_PAGE_1_RTMP_URL=rtmps://live-api-s.facebook.com:443/rtmp/
FB_PAGE_1_STREAM_KEY=FB-XXXXXXXXXXXX
FB_PAGE_2_RTMP_URL=rtmps://live-api-s.facebook.com:443/rtmp/
FB_PAGE_2_STREAM_KEY=FB-XXXXXXXXXXXX
FB_PAGE_3_RTMP_URL=rtmps://live-api-s.facebook.com:443/rtmp/
FB_PAGE_3_STREAM_KEY=FB-XXXXXXXXXXXX
```

Poi riavvia:
```bash
docker compose restart go-live
```

---

## Step 5: Configura Instagram

### Esporta cookie dal browser
1. Installa l'estensione **"EditThisCookie"** su Chrome
2. Accedi a instagram.com con il primo account
3. Clicca l'icona di EditThisCookie → **Export** (copia come JSON)
4. Apri la dashboard: `https://golive-malimass.duckdns.org`
5. Clicca **Aggiorna Cookie** accanto all'account
6. Incolla il JSON e clicca **Cifra e Salva**
7. Lo schermo mostra il valore cifrato → copialo
8. Incollalo nel `.env` come `IG_ACCOUNT_1_COOKIES_ENC=...`
9. Ripeti per gli altri 2 account

### Rinnovo cookie (~ogni 90 giorni)
Quando i cookie scadono, la dashboard mostra un avviso. Ripeti il processo sopra.

---

## Step 6: Configura la DJI Osmo Action 4

1. Apri l'app **DJI Mimo** sul telefono
2. Connetti la camera
3. Vai su **Impostazioni Trasmissione Live** → **RTMP**
4. Inserisci URL:
   ```
   rtmp://golive-malimass.duckdns.org:1935/live/TUA_RTMP_KEY
   ```
   (sostituisci `TUA_RTMP_KEY` con la chiave scelta durante il setup)
5. Risoluzione consigliata: **1080p 30fps**
6. Bitrate: **4000-6000 kbps**

---

## Uso quotidiano

### Andare live
1. Accendi la DJI Osmo Action 4
2. Avvia lo streaming RTMP dalla camera
3. Il server rileva automaticamente lo stream
4. Distribuisce a tutte le 6 destinazioni
5. Controlla stato su `https://golive-malimass.duckdns.org`

### Fermare la live
- La live si ferma automaticamente quando spegni la camera
- Oppure dalla dashboard: clicca **Ferma Distribuzione**

### Comandi utili (via SSH)
```bash
cd GO-LIVE

# Vedi log in tempo reale
docker compose logs -f go-live

# Riavvia il server
docker compose restart go-live

# Ferma tutto
docker compose down

# Aggiorna dopo un git pull
git pull
docker compose up -d --build

# Vedi stato container
docker compose ps
```

---

## Troubleshooting

### La camera non si connette
- Verifica che la porta 1935 sia aperta su Oracle Cloud (Security List)
- Verifica il firewall sulla VM: `sudo iptables -L -n | grep 1935`
- Verifica che il container sia attivo: `docker compose ps`
- Controlla la RTMP key: deve corrispondere a `RTMP_INGEST_KEY` nel `.env`

### Instagram dice "cookie scaduti"
- Rinnova i cookie dal browser (vedi Step 5)
- I cookie durano circa 90 giorni

### Un destinazione va in errore
- Il server riprova automaticamente fino a 3 volte
- Controlla i log: `docker compose logs -f go-live`
- Se Facebook da errore, verifica che la stream key sia ancora valida

### Dashboard non si apre
- Verifica SSL: `docker compose logs nginx`
- Verifica certbot: `docker compose logs certbot`
- Prova HTTP diretto: `http://TUO_IP:3000`

### Aggiornare il progetto
```bash
cd GO-LIVE
git pull
docker compose up -d --build
```
