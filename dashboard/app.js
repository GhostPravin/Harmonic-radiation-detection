/**
 * EV Charger IoT Dashboard – app.js
 * ====================================
 * Connects via WebSocket to Node.js server.
 * Renders live charts, KPI cards, gauge, relay status, and event log.
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────
const WS_URL      = `ws://${location.hostname}:3000`;
const MAX_POINTS  = 60;   // max data points on chart
const MAX_LOG     = 50;   // max rows in event log
const CURRENT_MAX_RANGE = 2.0;
const VIN_MAX_RANGE     = 25.0;
const VBAT_MAX_RANGE    = 25.0;
const POWER_MAX_RANGE   = 50.0;
const DATA_TIMEOUT_MS   = 5000; // ms – mark ESP32 offline if no data received

// Battery % gauge voltage range (must match firmware VBAT constants)
const VBAT_MIN  = 5.0;   // Volts → 0%
const VBAT_FULL = 12.4;  // Volts → 100% (matches firmware VBAT_FULL)

// ── State ─────────────────────────────────────────────────────────────────
let ws;
let reconnectTimer;
let dataTimeoutTimer = null;  // fires if ESP32 stops sending data
let chart;

const labels      = [];
const vinData     = [];
const vbatData    = [];
const currentData = [];

// ── Change-Detection for Event Log ────────────────────────────────────────
// Thresholds: log a new row only when a value shifts more than this amount
const LOG_THRESHOLDS = {
  vin:     0.5,   // Volts
  vbat:    0.5,   // Volts
  current: 0.05,  // Amps
  power:   1.0,   // Watts
};

let lastLog = null; // last reading that was logged

function hasChanged(d) {
  if (!lastLog) return true;                           // always log first reading
  if (d.relay !== lastLog.relay) return true;          // relay state flip → always log
  if (Math.abs(d.vin     - lastLog.vin)     >= LOG_THRESHOLDS.vin)     return true;
  if (Math.abs(d.vbat    - lastLog.vbat)    >= LOG_THRESHOLDS.vbat)    return true;
  if (Math.abs(d.current - lastLog.current) >= LOG_THRESHOLDS.current) return true;
  if (Math.abs(d.power   - lastLog.power)   >= LOG_THRESHOLDS.power)   return true;
  return false;
}

// ── DOM Refs ──────────────────────────────────────────────────────────────
const connDot     = document.getElementById('connDot');
const connLabel   = document.getElementById('connLabel');
const clockEl     = document.getElementById('clock');
const dateEl      = document.getElementById('dateLabel');
const logBody     = document.getElementById('logBody');
const relayRing   = document.getElementById('relayRing');
const relayState  = document.getElementById('relayState');
const relayDesc   = document.getElementById('relayDesc');
const gaugeArc    = document.getElementById('gaugeArc');
const needle      = document.getElementById('needle');
const gaugeValEl  = document.getElementById('gaugeVal');

// KPI elements
const kpiVin     = document.getElementById('kpi-vin');
const kpiVbat    = document.getElementById('kpi-vbat');
const kpiCurrent = document.getElementById('kpi-current');
const kpiPower   = document.getElementById('kpi-power');
const barVin     = document.getElementById('bar-vin');
const barVbat    = document.getElementById('bar-vbat');
const barCurrent = document.getElementById('bar-current');
const barPower   = document.getElementById('bar-power');
const cardCurrent = document.getElementById('card-current');

// ── Clock ─────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString('en-IN', { hour12: false });
  dateEl.textContent  = now.toLocaleDateString('en-IN', { weekday:'short', day:'2-digit', month:'short', year:'numeric' });
}
setInterval(updateClock, 1000);
updateClock();

// ── Particles ─────────────────────────────────────────────────────────────
(function spawnParticles() {
  const container = document.getElementById('particles');
  const colors = ['#00d4ff','#00ff88','#ffe600','#b57bff'];
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const sz = Math.random() * 4 + 1;
    p.style.cssText = `
      width:${sz}px; height:${sz}px;
      left:${Math.random()*100}%;
      background:${colors[Math.floor(Math.random()*colors.length)]};
      animation-duration:${8 + Math.random()*12}s;
      animation-delay:${Math.random()*10}s;
    `;
    container.appendChild(p);
  }
})();

// ── Chart.js Setup ────────────────────────────────────────────────────────
function initChart() {
  const ctx = document.getElementById('liveChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Vin (V)',
          data: vinData,
          borderColor: '#00d4ff',
          backgroundColor: 'rgba(0,212,255,0.06)',
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.45,
          fill: true,
        },
        {
          label: 'Vbat (V)',
          data: vbatData,
          borderColor: '#00ff88',
          backgroundColor: 'rgba(0,255,136,0.06)',
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.45,
          fill: true,
        },
        {
          label: 'Current ×10',
          data: currentData,
          borderColor: '#ffe600',
          backgroundColor: 'rgba(255,230,0,0.06)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.45,
          fill: true,
          borderDash: [4, 2],
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid: { color: 'rgba(0,212,255,0.07)' },
          ticks: {
            color: 'rgba(200,220,255,0.4)',
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            maxTicksLimit: 10,
            maxRotation: 0,
          },
        },
        y: {
          grid: { color: 'rgba(0,212,255,0.07)' },
          ticks: {
            color: 'rgba(200,220,255,0.4)',
            font: { family: "'JetBrains Mono', monospace", size: 11 },
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(8,20,50,0.92)',
          borderColor: 'rgba(0,212,255,0.3)',
          borderWidth: 1,
          titleColor: '#00d4ff',
          bodyColor: '#e8f4ff',
          titleFont: { family: "'Orbitron', monospace", size: 11 },
          bodyFont:  { family: "'JetBrains Mono', monospace", size: 11 },
        },
      },
    },
  });
  // Height is controlled via CSS (.chart-canvas-wrap)
}

// ── KPI Updaters ──────────────────────────────────────────────────────────
function updateKPIs(d) {
  const { vin, vbat, current, power, relay } = d;
  const tripped = relay === 'TRIP';
  const full    = relay === 'FULL';

  kpiVin.textContent     = vin.toFixed(1);
  kpiVbat.textContent    = vbat.toFixed(1);
  kpiCurrent.textContent = current.toFixed(2);
  kpiPower.textContent   = power.toFixed(1);

  barVin.style.width     = `${Math.min(vin / VIN_MAX_RANGE * 100, 100)}%`;
  barVbat.style.width    = `${Math.min(vbat / VBAT_MAX_RANGE * 100, 100)}%`;
  barCurrent.style.width = `${Math.min(current / CURRENT_MAX_RANGE * 100, 100)}%`;
  barPower.style.width   = `${Math.min(power / POWER_MAX_RANGE * 100, 100)}%`;

  // Highlight current card red on overcurrent, green on battery full
  cardCurrent.classList.toggle('trip', tripped);

  // Highlight battery card green on full-charge
  const cardVbat = document.getElementById('card-vbat');
  if (cardVbat) cardVbat.classList.toggle('full-charge', full);
}

// ── Relay Updater ─────────────────────────────────────────────────────────
function updateRelay(relay) {
  const tripped = relay === 'TRIP';
  const full    = relay === 'FULL';
  const on      = relay === 'ON';

  relayRing.classList.toggle('trip', tripped);
  relayRing.classList.toggle('full', full);

  if (full) {
    relayState.textContent = 'BATTERY FULL';
    relayState.className   = 'relay-state full';
    relayDesc.textContent  = '🔋 Battery fully charged – charging stopped';
    document.getElementById('relayIcon').textContent = '✅';
  } else if (tripped) {
    relayState.textContent = 'TRIPPED';
    relayState.className   = 'relay-state trip';
    relayDesc.textContent  = '⚠ Overcurrent detected – relay open';
    document.getElementById('relayIcon').textContent = '🚫';
  } else {
    relayState.textContent = 'CHARGING';
    relayState.className   = 'relay-state';
    relayDesc.textContent  = '✅ Normal operation – relay closed';
    document.getElementById('relayIcon').textContent = '⚡';
  }
}

// ── Battery Gauge Updater ─────────────────────────────────────────────────
// Gauge arc full length ≈ 283 (π × r = π × 90 ≈ 283)
// Needle: -90° = 0% (left) → +90° = 100% (right)
// Gradient: red (left/empty) → yellow → green (right/full)
function updateGauge(vbat) {
  const pct = Math.min(Math.max((vbat - VBAT_MIN) / (VBAT_FULL - VBAT_MIN), 0), 1);

  // Arc fill
  const dashOffset = 283 - pct * 283;
  gaugeArc.setAttribute('stroke-dashoffset', dashOffset.toFixed(1));

  // Needle
  const angle = -90 + pct * 180;
  needle.setAttribute('transform', `rotate(${angle.toFixed(1)} 100 110)`);

  // Colour: red < 20%, yellow 20-50%, green ≥ 50%
  const pctInt = Math.round(pct * 100);
  let arcColor;
  if (pctInt < 20)       arcColor = '#ff4444';
  else if (pctInt < 50)  arcColor = '#ffe600';
  else                   arcColor = '#00ff88';

  gaugeValEl.textContent = pctInt + '%';
  gaugeValEl.style.color = arcColor;
  gaugeValEl.style.textShadow = `0 0 14px ${arcColor}`;
  gaugeArc.setAttribute('stroke', 'url(#gaugeGrad)');
}

// ── Chart Updater ─────────────────────────────────────────────────────────
function pushChartPoint(d) {
  const t = new Date(d.timestamp).toLocaleTimeString('en-IN', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  labels.push(t);
  vinData.push(d.vin);
  vbatData.push(d.vbat);
  currentData.push(+(d.current * 10).toFixed(3)); // scale ×10 for visibility

  if (labels.length > MAX_POINTS) {
    labels.shift(); vinData.shift(); vbatData.shift(); currentData.shift();
  }

  chart.update('none'); // no animation for live streaming
}

// ── Log Updater ──────────────────────────────────────────────────────────
function addLogRow(d, force = false) {
  // Only log when something meaningful changed (or forced)
  if (!force && !hasChanged(d)) return;

  // Capture previous relay state BEFORE updating lastLog baseline
  const prevRelay = lastLog ? lastLog.relay : null;
  lastLog = { ...d }; // snapshot as new baseline

  const t = new Date(d.timestamp).toLocaleTimeString('en-IN', { hour12: false });
  const tripped = d.relay === 'TRIP';
  const full    = d.relay === 'FULL';

  // Remove empty placeholder
  const empty = logBody.querySelector('.log-empty');
  if (empty) empty.parentElement.remove();

  // Append a badge when relay state flips
  let badge = '';
  if (prevRelay !== null && d.relay !== prevRelay) {
    if (d.relay === 'TRIP') {
      badge = ' <span class="log-badge badge-trip">⚠ TRIPPED</span>';
    } else if (d.relay === 'FULL') {
      badge = ' <span class="log-badge badge-full">🔋 BATTERY FULL</span>';
    } else {
      badge = ' <span class="log-badge badge-ok">✅ Recovered</span>';
    }
  }

  const tr = document.createElement('tr');
  tr.className = 'row-new';
  tr.innerHTML = `
    <td>${t}</td>
    <td>${d.vin.toFixed(1)}</td>
    <td>${d.vbat.toFixed(1)}</td>
    <td>${d.current.toFixed(2)}</td>
    <td>${d.power.toFixed(1)}</td>
    <td class="${tripped ? 'status-trip' : full ? 'status-full' : 'status-ok'}">${d.relay}${badge}</td>
  `;

  logBody.prepend(tr);

  // Trim old rows
  while (logBody.children.length > MAX_LOG) {
    logBody.removeChild(logBody.lastChild);
  }
}

function clearLog() {
  logBody.innerHTML = '<tr><td colspan="6" class="log-empty">Log cleared</td></tr>';
}

// ── Render Data ───────────────────────────────────────────────────────────
function render(d) {
  updateKPIs(d);
  updateRelay(d.relay);
  updateGauge(d.vbat);   // battery % based on vbat
  pushChartPoint(d);
  addLogRow(d); // internally checks hasChanged()
}

// Load history on init – populate chart but do NOT spam the log
function loadHistory(history) {
  if (!history || !history.length) return;

  history.forEach(d => {
    labels.push(new Date(d.timestamp).toLocaleTimeString('en-IN', { hour12: false }));
    vinData.push(d.vin);
    vbatData.push(d.vbat);
    currentData.push(+(d.current * 10).toFixed(3));
    if (labels.length > MAX_POINTS) {
      labels.shift(); vinData.shift(); vbatData.shift(); currentData.shift();
    }
  });
  chart.update();

  // Only log the very last history point as the initial baseline
  const last = history[history.length - 1];
  updateKPIs(last);
  updateRelay(last.relay);
  updateGauge(last.vbat); // battery % based on vbat
  addLogRow(last, true); // force=true → log unconditionally as baseline
}

// ── WebSocket Status ──────────────────────────────────────────────────────
// 3 states: 'online' (green)  = data flowing from ESP32
//           'waiting' (amber) = WS connected but no ESP32 data yet / timed out
//           'offline' (red)   = WebSocket disconnected from server
function setConnStatus(state) {
  connDot.className  = 'conn-dot ' + state;
  if (state === 'online')  connLabel.textContent = 'ESP32 ONLINE';
  if (state === 'waiting') connLabel.textContent = 'ESP32 OFFLINE';
  if (state === 'offline') connLabel.textContent = 'DISCONNECTED';
}

// Called every time a data packet arrives from the ESP32
function markEsp32Active() {
  setConnStatus('online');
  clearTimeout(dataTimeoutTimer);
  dataTimeoutTimer = setTimeout(() => setConnStatus('waiting'), DATA_TIMEOUT_MS);
}

function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[WS] Connected');
    setConnStatus('waiting'); // WS up, but wait for actual ESP32 data
    clearTimeout(reconnectTimer);
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'init') {
        loadHistory(msg.history);
        if (msg.payload && msg.payload.vin !== undefined) {
          markEsp32Active(); // history means ESP32 was active recently
          render(msg.payload);
        }
      } else if (msg.type === 'data') {
        markEsp32Active(); // live packet – ESP32 is online
        render(msg.payload);
      }
    } catch (e) {
      console.warn('[WS] Parse error:', e);
    }
  };

  ws.onclose = () => {
    console.warn('[WS] Closed – reconnecting in 3s');
    clearTimeout(dataTimeoutTimer);
    setConnStatus('offline');
    reconnectTimer = setTimeout(connectWS, 3000);
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
    ws.close();
  };
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  connectWS();
});
