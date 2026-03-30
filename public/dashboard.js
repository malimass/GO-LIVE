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
      if (container && data.destinations.length > 0) {
        container.innerHTML = data.destinations.map((d) => `
          <div class="dest-card dest-${d.status}">
            <div class="dest-header">
              <span class="dest-icon">${d.platform === 'facebook' ? 'FB' : 'IG'}</span>
              <span class="dest-name">${d.name}</span>
            </div>
            <div class="dest-status">${d.status}</div>
            ${d.health ? `<div class="dest-health"><span>${d.health.fps} fps</span><span>${d.health.bitrate}</span></div>` : ''}
          </div>
        `).join('');
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
        container.innerHTML = data.logs.map((line) => `<div class="log-line">${escapeHtml(line)}</div>`).join('');
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
      <input type="text" value="rtmps://live-api-s.facebook.com:443/rtmp/" placeholder="RTMP URL" class="fb-url">
      <input type="text" placeholder="Stream Key" class="fb-key">
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
  const rtmpUrl = row.querySelector('.fb-url').value.trim();
  const streamKey = row.querySelector('.fb-key').value.trim();

  if (!name || !streamKey) {
    alert('Nome e Stream Key sono obbligatori');
    return;
  }

  fetch('/api/config/facebook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name, rtmpUrl, streamKey }),
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

  if (!name || !username) {
    alert('Nome e Username sono obbligatori');
    return;
  }

  fetch('/api/config/instagram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name, username }),
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
