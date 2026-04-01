const STATUS_INTERVAL = 3000;
const LOGS_INTERVAL = 10000;

// === STATUS POLLING ===
function updateStatus() {
  fetch('/api/status')
    .then((res) => res.json())
    .then((data) => {
      const badge = document.getElementById('live-badge');
      if (badge) {
        badge.textContent = data.live ? 'LIVE' : 'OFFLINE';
        badge.className = `badge ${data.live ? 'badge-live' : 'badge-offline'}`;
      }
      const btnStop = document.getElementById('btn-stop');
      if (btnStop) btnStop.disabled = !data.live;

      const container = document.getElementById('destinations');
      // Update live timer
      const timerEl = document.getElementById('live-timer');
      if (timerEl) {
        if (data.live && data.startedAt) {
          if (!window._liveStartedAt) window._liveStartedAt = data.startedAt;
          const elapsed = Math.floor((Date.now() - new Date(window._liveStartedAt).getTime()) / 1000);
          const h = Math.floor(elapsed / 3600);
          const m = Math.floor((elapsed % 3600) / 60);
          const s = elapsed % 60;
          timerEl.textContent = `${h > 0 ? h + 'h ' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
          timerEl.classList.remove('hidden');
        } else {
          window._liveStartedAt = null;
          timerEl.classList.add('hidden');
        }
      }

      if (container) {
        if (data.destinations.length > 0) {
          container.innerHTML = data.destinations.map((d) => {
            const icon = d.platform === 'facebook' ? 'FB' : 'IG';
            const statusLabel = d.status === 'running' ? 'In onda' : d.status === 'error' ? 'Errore' : d.status === 'stopped' ? 'Fermato' : 'In attesa';
            return `
            <div class="dest-card dest-${d.status}" data-platform="${d.platform}">
              <div class="dest-header">
                <span class="dest-icon dest-icon-${d.platform}">${icon}</span>
                <span class="dest-name">${d.name}</span>
              </div>
              <div class="dest-status">${statusLabel}</div>
              ${d.health ? `<div class="dest-health">
                <span>${d.health.fps} fps</span>
                <span>${d.health.bitrate}</span>
                ${d.health.uptime ? `<span>${formatUptime(d.health.uptime)}</span>` : ''}
              </div>` : ''}
            </div>`;
          }).join('');
        } else {
          container.innerHTML = '<p class="muted">Nessun stream attivo. Le destinazioni appariranno quando la camera si connette.</p>';
        }
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
        container.innerHTML = data.logs.map((line) => `<div class="log-line ${getLogClass(line)}">${escapeHtml(line)}</div>`).join('');
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

function formatUptime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getLogClass(line) {
  if (line.includes('[ERROR]')) return 'log-error';
  if (line.includes('[WARN]')) return 'log-warn';
  if (line.includes('Started') || line.includes('Broadcast started')) return 'log-success';
  return '';
}

// === RTMP URL ===
function copyRtmpUrl() {
  const url = document.getElementById('rtmp-url').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const btn = event.target;
    btn.textContent = 'Copiato!';
    setTimeout(() => btn.textContent = 'Copia', 2000);
  });
}

// === STREAM CONTROLS ===
function stopStream() {
  if (!confirm('Sei sicuro di voler fermare la distribuzione?')) return;
  fetch('/api/stream/stop', { method: 'POST' })
    .then((res) => res.json())
    .then(() => updateStatus())
    .catch((err) => alert('Errore: ' + err.message));
}

// === FACEBOOK CRUD ===
function addFbRow() {
  const list = document.getElementById('fb-list');
  const row = document.createElement('div');
  row.className = 'config-row';
  row.dataset.id = '';
  row.innerHTML = `
    <div class="config-fields">
      <input type="text" placeholder="Nome (es. Pagina 1)" class="fb-name">
      <input type="text" placeholder="Page ID" class="fb-page-id">
      <input type="text" value="LIVE" placeholder="Titolo Live" class="fb-title">
      <span class="cookie-status cookie-missing">No token</span>
    </div>
    <div class="config-actions">
      <button class="btn btn-sm btn-primary" onclick="saveFb(this)">Salva</button>
      <button class="btn btn-sm btn-danger" onclick="this.closest('.config-row').remove()">X</button>
    </div>
  `;
  list.appendChild(row);
}

function saveFb(btn) {
  const row = btn.closest('.config-row');
  const id = row.dataset.id ? parseInt(row.dataset.id) : null;
  const name = row.querySelector('.fb-name').value.trim();
  const pageId = row.querySelector('.fb-page-id').value.trim();
  const liveTitle = row.querySelector('.fb-title') ? row.querySelector('.fb-title').value.trim() : 'LIVE';

  if (!name || !pageId) {
    alert('Nome e Page ID sono obbligatori');
    return;
  }

  // If new row, need token too — prompt to save first then add token
  const body = { id, name, pageId, liveTitle };

  // For existing rows, don't send token (keep existing)
  // For new rows, send a placeholder and user adds token after
  if (!id) {
    body.pageAccessToken = prompt('Incolla il Page Access Token:');
    if (!body.pageAccessToken) {
      alert('Page Access Token obbligatorio');
      return;
    }
  }

  fetch('/api/config/facebook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        location.reload();
      } else {
        alert(data.error || 'Errore');
      }
    })
    .catch((err) => alert('Errore: ' + err.message));
}

// === FACEBOOK TOKEN UPLOAD ===
function showTokenUpload(accountId) {
  document.getElementById('token-account-id').value = accountId;
  document.getElementById('token-input').value = '';
  document.getElementById('token-modal').classList.remove('hidden');
}

function closeTokenModal() {
  document.getElementById('token-modal').classList.add('hidden');
}

function uploadToken() {
  const accountId = document.getElementById('token-account-id').value;
  const token = document.getElementById('token-input').value.trim();

  if (!token) {
    alert('Incolla un token valido');
    return;
  }

  // Get current row data to send full update
  const row = document.querySelector(`.config-row[data-id="${accountId}"]`);
  const name = row.querySelector('.fb-name').value.trim();
  const pageId = row.querySelector('.fb-page-id').value.trim();
  const liveTitle = row.querySelector('.fb-title') ? row.querySelector('.fb-title').value.trim() : 'LIVE';

  fetch('/api/config/facebook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: parseInt(accountId), name, pageId, pageAccessToken: token, liveTitle }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        closeTokenModal();
        location.reload();
      } else {
        alert(data.error || 'Errore');
      }
    })
    .catch((err) => alert('Errore: ' + err.message));
}

function deleteFb(id) {
  if (!confirm('Eliminare questa pagina Facebook?')) return;
  fetch(`/api/config/facebook/${id}`, { method: 'DELETE' })
    .then((res) => res.json())
    .then(() => location.reload())
    .catch((err) => alert('Errore: ' + err.message));
}

// === INSTAGRAM CRUD ===
function addIgRow() {
  const list = document.getElementById('ig-list');
  const row = document.createElement('div');
  row.className = 'config-row';
  row.dataset.id = '';
  row.innerHTML = `
    <div class="config-fields">
      <input type="text" placeholder="Nome (es. Account 1)" class="ig-name">
      <input type="text" placeholder="Username" class="ig-username">
      <span class="cookie-status cookie-missing">No cookie</span>
    </div>
    <div class="config-actions">
      <button class="btn btn-sm btn-primary" onclick="saveIg(this)">Salva</button>
      <button class="btn btn-sm btn-danger" onclick="this.closest('.config-row').remove()">X</button>
    </div>
  `;
  list.appendChild(row);
}

function saveIg(btn) {
  const row = btn.closest('.config-row');
  const id = row.dataset.id ? parseInt(row.dataset.id) : null;
  const name = row.querySelector('.ig-name').value.trim();
  const username = row.querySelector('.ig-username').value.trim();
  const liveTitle = row.querySelector('.ig-title') ? row.querySelector('.ig-title').value.trim() : 'LIVE';
  const audience = row.querySelector('.ig-audience') ? row.querySelector('.ig-audience').value : 'public';

  if (!name || !username) {
    alert('Nome e Username sono obbligatori');
    return;
  }

  fetch('/api/config/instagram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name, username, liveTitle, audience }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        location.reload();
      } else {
        alert(data.error || 'Errore');
      }
    })
    .catch((err) => alert('Errore: ' + err.message));
}

function deleteIg(id) {
  if (!confirm('Eliminare questo account Instagram?')) return;
  fetch(`/api/config/instagram/${id}`, { method: 'DELETE' })
    .then((res) => res.json())
    .then(() => location.reload())
    .catch((err) => alert('Errore: ' + err.message));
}

// === COOKIE UPLOAD ===
function showCookieUpload(accountId) {
  document.getElementById('cookie-account-id').value = accountId;
  document.getElementById('cookie-input').value = '';
  document.getElementById('cookie-result').classList.add('hidden');
  document.getElementById('cookie-modal').classList.remove('hidden');
}

function closeCookieModal() {
  document.getElementById('cookie-modal').classList.add('hidden');
}

function uploadCookies() {
  const accountId = document.getElementById('cookie-account-id').value;
  const rawCookies = document.getElementById('cookie-input').value.trim();

  let cookies;
  try {
    cookies = JSON.parse(rawCookies);
    if (!Array.isArray(cookies)) throw new Error('Must be array');
  } catch (e) {
    alert('Cookie non validi. Incolla un JSON array valido.');
    return;
  }

  fetch(`/api/config/instagram/${accountId}/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        closeCookieModal();
        location.reload();
      } else {
        alert(data.error || 'Errore');
      }
    })
    .catch((err) => alert('Errore: ' + err.message));
}

// === POLLING ===
setInterval(updateStatus, STATUS_INTERVAL);
setInterval(updateLogs, LOGS_INTERVAL);
updateStatus();
updateLogs();
