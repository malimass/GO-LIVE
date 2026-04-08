// Phone Stream — Browser-based camera capture + WebSocket ingest

(function () {
  'use strict';

  const preview = document.getElementById('preview');
  const btnStream = document.getElementById('btn-stream');
  const btnFlip = document.getElementById('btn-flip');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const streamTimer = document.getElementById('stream-timer');
  const healthInfo = document.getElementById('health-info');
  const errorOverlay = document.getElementById('error-overlay');
  const errorMessage = document.getElementById('error-message');
  const wakeWarning = document.getElementById('wake-warning');

  const TOKEN = window.__INGEST_TOKEN__;

  let state = 'idle'; // idle | connecting | streaming
  let facingMode = 'environment'; // environment (rear) | user (front)
  let mediaStream = null;
  let mediaRecorder = null;
  let ws = null;
  let startTime = null;
  let timerInterval = null;
  let statusInterval = null;
  let wakeLock = null;

  // ── Camera ──

  async function initCamera() {
    try {
      if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
      }

      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      preview.srcObject = mediaStream;

      // Track ended (e.g. permission revoked)
      mediaStream.getVideoTracks()[0].onended = () => {
        if (state === 'streaming') {
          stopStreaming();
          showError('La camera e\' stata disconnessa');
        }
      };
    } catch (err) {
      showError('Impossibile accedere alla camera. Controlla i permessi del browser.');
      throw err;
    }
  }

  function flipCamera() {
    if (state === 'streaming') return; // can't flip while streaming
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    initCamera();
  }

  // ── Streaming ──

  function startStreaming() {
    if (state !== 'idle' || !mediaStream) return;
    setState('connecting');

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/phone-ingest?token=${encodeURIComponent(TOKEN)}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // Determine best codec — webm for Chrome/Android, mp4 for Safari/iOS
      const mimeTypes = [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm',
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4',
      ];
      let mimeType = '';
      for (const mt of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mt)) {
          mimeType = mt;
          break;
        }
      }

      if (!mimeType) {
        showError('Il browser non supporta la registrazione video. Usa Chrome o Safari.');
        ws.close();
        return;
      }

      // Tell server which format we're sending
      ws.send(JSON.stringify({ type: 'init', mimeType }));

      try {
        mediaRecorder = new MediaRecorder(mediaStream, {
          mimeType,
          videoBitsPerSecond: 2500000,
        });
      } catch (err) {
        showError('Errore nella creazione del registratore: ' + err.message);
        ws.close();
        return;
      }

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      mediaRecorder.onerror = () => {
        stopStreaming();
        showError('Errore durante la registrazione');
      };

      mediaRecorder.start(500); // chunk every 500ms
      setState('streaming');
      startTime = Date.now();
      startTimer();
      acquireWakeLock();
      startStatusPolling();
    };

    ws.onclose = (e) => {
      if (state === 'streaming' || state === 'connecting') {
        const reason = e.reason || 'Connessione persa';
        stopStreaming();
        if (e.code === 4001) {
          showError('Un altro telefono sta gia\' trasmettendo');
        } else if (e.code === 4002) {
          showError('Un\'altra sorgente e\' gia\' in live');
        } else if (e.code !== 1000) {
          showError('Connessione chiusa: ' + reason);
        }
      }
    };

    ws.onerror = () => {
      if (state === 'connecting') {
        stopStreaming();
        showError('Impossibile connettersi al server');
      }
    };
  }

  function stopStreaming() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    mediaRecorder = null;

    if (ws) {
      ws.close(1000);
      ws = null;
    }

    stopTimer();
    stopStatusPolling();
    releaseWakeLock();
    setState('idle');
  }

  // ── State ──

  function setState(newState) {
    state = newState;
    btnStream.dataset.state = newState;
    statusDot.className = newState;

    const labels = { idle: 'AVVIA', connecting: '...', streaming: 'STOP' };
    btnStream.querySelector('.btn-label').textContent = labels[newState];

    const statusLabels = { idle: 'Pronto', connecting: 'Connessione...', streaming: 'LIVE' };
    statusText.textContent = statusLabels[newState];

    // Disable flip while streaming
    btnFlip.style.opacity = newState === 'idle' ? '1' : '0.3';
    btnFlip.style.pointerEvents = newState === 'idle' ? 'auto' : 'none';
  }

  // ── Timer ──

  function startTimer() {
    streamTimer.classList.remove('hidden');
    timerInterval = setInterval(updateTimer, 1000);
  }

  function stopTimer() {
    streamTimer.classList.add('hidden');
    healthInfo.classList.add('hidden');
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    startTime = null;
  }

  function updateTimer() {
    if (!startTime) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    streamTimer.textContent = `${h}:${m}:${s}`;
  }

  // ── Status polling ──

  function startStatusPolling() {
    statusInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/phone-stream/status');
        const data = await res.json();
        if (data.health) {
          healthInfo.classList.remove('hidden');
          healthInfo.textContent = `${data.health.fps} fps · ${data.health.bitrate}`;
        }
      } catch { /* ignore */ }
    }, 3000);
  }

  function stopStatusPolling() {
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
  }

  // ── Wake Lock ──

  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      } else {
        // Show warning if wake lock not available
        wakeWarning.classList.remove('hidden');
      }
    } catch { /* ignore — user may have denied */ }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
    }
  }

  // Re-acquire wake lock when tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state === 'streaming' && !wakeLock) {
      acquireWakeLock();
    }
  });

  // ── Error ──

  function showError(msg) {
    errorMessage.textContent = msg;
    errorOverlay.classList.remove('hidden');
  }

  window.dismissError = function () {
    errorOverlay.classList.add('hidden');
  };

  // ── Events ──

  btnStream.addEventListener('click', () => {
    if (state === 'idle') {
      startStreaming();
    } else if (state === 'streaming') {
      stopStreaming();
    }
  });

  btnFlip.addEventListener('click', flipCamera);

  // ── Init ──

  initCamera().catch(() => {
    // Error already shown by initCamera
  });
})();
