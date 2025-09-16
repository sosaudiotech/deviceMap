// mapServer.js — Express + WebSocket, serves /public and simple APIs
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { getDB } from "./db.js";
getDB().then(({ paths }) => console.log("🗺️ Device JSON path:", paths.devicesFile));


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Static site
app.use('/', express.static(path.join(__dirname, 'public')));

// Health for reverse proxy checks
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Floors (building/floor registry)
app.get('/api/floors', async (_req, res) => {
  const { floors } = await getDB();
  res.json(floors.data.floors);
});

// Devices (live list)
app.get('/api/devices', async (_req, res) => {
  const { devices } = await getDB();
  res.json(devices.data.devices);
});


// Update normalized coords for a device id (id can be IP or GUID — string match)
app.put('/api/devices/:id/coords', async (req, res) => {
  const { x, y } = req.body || {};
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).json({ error: 'x and y must be finite numbers in [0,1]' });
  }

  const { devices } = await getDB();
  const idx = devices.data.devices.findIndex(d => String(d.id) === String(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Device not found' });

  devices.data.devices[idx].coords = { x: clamp01(x), y: clamp01(y) };
  await devices.write();

  broadcast({ type: 'device.coords.updated', device: devices.data.devices[idx] });
  res.json({ ok: true, device: devices.data.devices[idx] });
});



function clamp01(v){ return Math.max(0, Math.min(1, v)); }

// WebSocket for realtime pushes
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(s);
  }
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Device Map sandbox running at http://localhost:${PORT}`);
});