// Poll status every 3 seconds
const STATUS_INTERVAL = 3000;
const LOGS_INTERVAL = 10000;

function updateStatus() {
  fetch('/api/status')
    .then((res) => res.json())
    .then((data) => {
      // Update live badge
      const badge = document.getElementById('live-badge');
      if (badge) {
        badge.textContent = data.live ? 'LIVE' : 'OFFLINE';
        badge.className = `badge ${data.live ? 'badge-live' : 'badge-offline'}`;
      }

      // Update stop button
      const btnStop = document.getElementById('btn-stop');
      if (btnStop) {
        btnStop.disabled = !data.live;
      }

      // Update destinations
      const container = document.getElementById('destinations');
      if (container && data.destinations.length > 0) {
        container.innerHTML = data.destinations
          .map((d) => `
            <div class="dest-card dest-${d.status}" data-name="${d.name}">
              <div class="dest-header">
                <span class="dest-icon">${d.platform === 'facebook' ? 'FB' : 'IG'}</span>
                <span class="dest-name">${d.name}</span>
              </div>
              <div class="dest-status">${d.status}</div>
              ${
                d.health
                  ? `<div class="dest-health">
                      <span>${d.health.fps} fps</span>
                      <span>${d.health.bitrate}</span>
                      <span>${d.health.speed}</span>
                    </div>`
                  : ''
              }
            </div>
          `)
          .join('');
      }
    })
    .catch(() => {});
}

function updateLogs() {
  fetch('/api/logs')
    .then((res) => res.json())
    .then((data) => {
      const container = document.getElementById('logs');
      if (container && data.logs) {
        container.innerHTML = data.logs
          .map((line) => `<div class="log-line">${escapeHtml(line)}</div>`)
          .join('');
        container.scrollTop = container.scrollHeight;
      }
    })
    .catch(() => {});
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Stream controls
function stopStream() {
  if (!confirm('Sei sicuro di voler fermare la distribuzione?')) return;

  fetch('/api/stream/stop', { method: 'POST' })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        updateStatus();
      } else {
        alert(data.message || data.error || 'Errore');
      }
    })
    .catch((err) => alert('Errore: ' + err.message));
}

// Cookie management
function showCookieUpload(accountIndex) {
  document.getElementById('cookie-account-index').value = accountIndex;
  document.getElementById('cookie-input').value = '';
  document.getElementById('cookie-result').classList.add('hidden');
  document.getElementById('cookie-modal').classList.remove('hidden');
}

function closeCookieModal() {
  document.getElementById('cookie-modal').classList.add('hidden');
}

function uploadCookies() {
  const accountIndex = parseInt(document.getElementById('cookie-account-index').value);
  const rawCookies = document.getElementById('cookie-input').value.trim();

  let cookies;
  try {
    cookies = JSON.parse(rawCookies);
    if (!Array.isArray(cookies)) throw new Error('Must be an array');
  } catch (e) {
    alert('Cookie non validi. Assicurati di incollare un JSON array valido.');
    return;
  }

  fetch('/api/config/ig-cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountIndex, cookies }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        const resultDiv = document.getElementById('cookie-result');
        resultDiv.classList.remove('hidden');
        resultDiv.innerHTML = `
          <div style="margin-top:1rem;padding:1rem;background:var(--bg);border-radius:6px;">
            <p style="color:var(--success);margin-bottom:0.5rem;">Cookie cifrati con successo!</p>
            <p style="margin-bottom:0.5rem;">Copia questo valore e impostalo come <strong>${data.envKey}</strong> nelle env vars di Railway:</p>
            <textarea readonly rows="3" style="width:100%;font-size:0.75rem;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:0.5rem;">${data.encryptedValue}</textarea>
          </div>
        `;
      } else {
        alert(data.error || 'Errore durante il salvataggio');
      }
    })
    .catch((err) => alert('Errore: ' + err.message));
}

// Start polling
setInterval(updateStatus, STATUS_INTERVAL);
setInterval(updateLogs, LOGS_INTERVAL);

// Initial load
updateStatus();
updateLogs();
