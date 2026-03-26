/**
 * EV Charger IoT Dashboard – Server
 * ====================================
 * - Receives sensor data from ESP32 via HTTP POST /api/data
 * - Broadcasts data to all connected WebSocket clients (dashboard)
 * - Serves the static dashboard frontend
 * - Maintains a circular buffer of the last 100 readings for chart history
 */

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const WebSocket = require('ws');
const dgram   = require('dgram');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const UDP_PORT = 3001; // Port used for auto-discovery broadcasts

// ─── UDP Auto-Discovery Server ───────────────────────────────────────────
const udpServer = dgram.createSocket('udp4');

udpServer.on('message', (msg, rinfo) => {
  const message = msg.toString().trim();
  if (message === 'EV_DISCOVER') {
    console.log(`[UDP] Discovery request from ESP32 at ${rinfo.address}:${rinfo.port}`);
    // Reply back with our HTTP port
    const reply = Buffer.from(`EV_SERVER:${PORT}`);
    udpServer.send(reply, rinfo.port, rinfo.address);
  }
});

udpServer.on('listening', () => {
  const address = udpServer.address();
  console.log(`[UDP] Auto-Discovery listening on port ${address.port}`);
});

udpServer.bind(UDP_PORT);

// ─── In-memory data store ────────────────────────────────────────────────
const MAX_HISTORY = 100;
let latestData = {
  vin: 0, vbat: 0, current: 0, power: 0,
  relay: 'ON', timestamp: Date.now()
};
let history = []; // array of reading objects

// ─── Middleware ──────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dashboard')));

// ─── REST API ────────────────────────────────────────────────────────────

// Receive data from ESP32
app.post('/api/data', (req, res) => {
  const d = req.body;
  if (!d || d.vin === undefined) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  latestData = {
    vin:       parseFloat(d.vin)     || 0,
    vbat:      parseFloat(d.vbat)    || 0,
    current:   parseFloat(d.current) || 0,
    power:     parseFloat(d.power)   || 0,
    relay:     d.relay || 'ON',
    timestamp: Date.now()
  };

  // Push to history ring buffer
  history.push({ ...latestData });
  if (history.length > MAX_HISTORY) history.shift();

  console.log(`[DATA] Vin=${latestData.vin}V  Vbat=${latestData.vbat}V  I=${latestData.current}A  P=${latestData.power}W  ${latestData.relay}`);

  // Broadcast to all WebSocket clients
  const msg = JSON.stringify({ type: 'data', payload: latestData });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });

  res.json({ ok: true });
});

// Get latest reading
app.get('/api/latest', (req, res) => {
  res.json(latestData);
});

// Get history (last N readings)
app.get('/api/history', (req, res) => {
  const n = Math.min(parseInt(req.query.n) || MAX_HISTORY, MAX_HISTORY);
  res.json(history.slice(-n));
});

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    server: 'running',
    clients: wss.clients.size,
    historyCount: history.length,
    uptime: process.uptime().toFixed(0) + 's'
  });
});

// ─── WebSocket ───────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] Client connected: ${ip}  (total: ${wss.clients.size})`);

  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: 'init', payload: latestData, history }));

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${ip}  (total: ${wss.clients.size})`);
  });

  ws.on('error', err => {
    console.error('[WS] Error:', err.message);
  });
});

// ─── Start ───────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   EV Charger IoT Dashboard Server        ║');
  console.log(`║   http://localhost:${PORT}                   ║`);
  console.log('║   Waiting for ESP32 data...              ║');
  console.log('╚══════════════════════════════════════════╝');
});
