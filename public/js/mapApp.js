// public/js/mapApp.js
const qs = (sel, el = document) => el.querySelector(sel);
const qsa = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  floors: [],
  devices: [],
  currentFloorId: null,
  admin: false,
  svgViewBox: null // {minX,minY,width,height}
};

const floorSelect = qs('#floor-select');
const adminToggle = qs('#admin-mode');
const searchInput = qs('#search');
const orientationFilter = qs('#orientation-filter');
const svgHost = qs('#svg-host');
const markerLayer = qs('#marker-layer');
const tooltip = qs('#tooltip');
const deviceList = qs('#device-list');

init();

async function init() {
  await loadFloors();
  await loadDevices();
  wireControls();
  connectWS();
  renderFloorSelect();
  autoPickFirstFloor();
}

function wireControls() {
  floorSelect.addEventListener('change', () => {
    state.currentFloorId = floorSelect.value;
    loadFloorSVG();
    render();
  });

  adminToggle.addEventListener('change', () => {
    state.admin = adminToggle.checked;
  });

  searchInput.addEventListener('input', () => render());
  orientationFilter.addEventListener('change', () => render());
}


async function loadFloors() {
  const res = await fetch('/api/floors');
  state.floors = await res.json();
}

async function loadDevices() {
  const res = await fetch('/api/devices');
  state.devices = await res.json();
}

function renderFloorSelect() {
  floorSelect.innerHTML = state.floors
    .map(f => `<option value="${f.id}">${f.label}</option>`)
    .join('');
}

function autoPickFirstFloor() {
  if (!state.currentFloorId && state.floors.length) {
    state.currentFloorId = state.floors[0].id;
    floorSelect.value = state.currentFloorId;
    loadFloorSVG().then(render);
  }
}

async function loadFloorSVG() {
  const floor = state.floors.find(f => f.id === state.currentFloorId);
  if (!floor) return;

  const res = await fetch(floor.svg);
  const svgText = await res.text();
  svgHost.innerHTML = svgText;

  const injected = svgHost.querySelector('svg');
  if (!injected) return;

  const vb = injected.getAttribute('viewBox') ||
             `0 0 ${injected.getAttribute('width')} ${injected.getAttribute('height')}`;
  const [minX, minY, width, height] = vb.split(/\s+/).map(Number);
  state.svgViewBox = { minX, minY, width, height };

  markerLayer.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
  markerLayer.setAttribute('preserveAspectRatio', injected.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
}


function render() {
  renderMarkers();
  renderList();
}

function devicesForCurrentFloor() {
  const floor = state.floors.find(f => f.id === state.currentFloorId);
  if (!floor) return [];
  const term = (searchInput.value || '').toLowerCase().trim();
  const orient = orientationFilter.value;

  return state.devices
    .filter(d => d.building === floor.building && d.floor === floor.floor)
    .filter(d => (orient ? (d.orientation === orient) : true))
    .filter(d => {
      if (!term) return true;
      return (d.name || '').toLowerCase().includes(term)
          || String(d.ip || '').includes(term)
          || String(d.id || '').includes(term);
    });
}

function renderMarkers() {
  const floorDevs = devicesForCurrentFloor();
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('id', 'markers');

  floorDevs.forEach(dev => {
    const { x = 0.5, y = 0.5 } = dev.coords || {};
    const { minX, minY, width, height } = state.svgViewBox || { minX:0, minY:0, width:100, height:100 };
    const px = minX + x * width;
    const py = minY + y * height;

    const node = markerNode(dev, px, py);
    g.appendChild(node);
  });

  markerLayer.innerHTML = '';
  markerLayer.appendChild(g);
}

function markerNode(dev, px, py) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.classList.add('marker');
  g.setAttribute('data-id', dev.id);
  g.setAttribute('transform', `translate(${px}, ${py})`);

  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('r', '6');

  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('x', '10');
  label.setAttribute('y', '4');
  label.textContent = dev.name || dev.id;

  g.appendChild(circle);
  g.appendChild(label);

  // Tooltip
  g.addEventListener('pointerenter', () => {
    tooltip.hidden = false;
    tooltip.innerHTML = `
      <strong>${dev.name || dev.id}</strong><br>
      ${dev.ip || ''}<br>
      ${dev.orientation || ''} — ${dev.building || ''} / ${dev.floor || ''}
    `;
  });
  g.addEventListener('pointerleave', () => { tooltip.hidden = true; });

  g.addEventListener('pointermove', (e) => {
    tooltip.style.left = (e.clientX + 12) + 'px';
    tooltip.style.top  = (e.clientY + 12) + 'px';
  });

  // Drag to place (Admin)
  let dragging = false;
  let lastPoint = null;

  g.addEventListener('pointerdown', (e) => {
    if (!state.admin) return;
    dragging = true;
    lastPoint = svgPointFromClient(e.clientX, e.clientY);
    g.classList.add('dragging');
    g.setPointerCapture(e.pointerId);
  });

  g.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = svgPointFromClient(e.clientX, e.clientY);
    const dx = p.x - lastPoint.x;
    const dy = p.y - lastPoint.y;
    lastPoint = p;

    const current = g.getAttribute('transform');
    const [, tx, ty] = current.match(/translate\(([-.\d]+),\s*([-. \d]+)\)/) || [0, px, py];
    const nx = parseFloat(tx) + dx;
    const ny = parseFloat(ty) + dy;
    g.setAttribute('transform', `translate(${nx}, ${ny})`);
  });

  g.addEventListener('pointerup', async (e) => {
    if (!dragging) return;
    dragging = false;
    g.classList.remove('dragging');
    g.releasePointerCapture(e.pointerId);

    const t = g.getAttribute('transform');
    const [, tx, ty] = t.match(/translate\(([-.\d]+),\s*([-. \d]+)\)/) || [];
    const { minX, minY, width, height } = state.svgViewBox;
    const normX = (parseFloat(tx) - minX) / width;
    const normY = (parseFloat(ty) - minY) / height;

    await saveCoords(dev.id, clamp01(normX), clamp01(normY));
  });

  return g;
}

function clamp01(v){ return Math.max(0, Math.min(1, v)); }

function svgPointFromClient(clientX, clientY) {
  const pt = markerLayer.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const ctm = markerLayer.getScreenCTM().inverse();
  return pt.matrixTransform(ctm);
}

async function saveCoords(id, x, y) {
  await fetch(`/api/devices/${encodeURIComponent(id)}/coords`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y })
  });
}

function renderList() {
  const floorDevs = devicesForCurrentFloor();
  deviceList.innerHTML = floorDevs.map(d => `
    <div class="card">
      <div><strong>${d.name || d.id}</strong></div>
      <div class="meta">${d.ip || ''} — ${d.orientation || ''}</div>
      <div class="meta">${d.building} / ${d.floor}</div>
      <div class="meta">x:${(d.coords?.x ?? 0.5).toFixed(3)} y:${(d.coords?.y ?? 0.5).toFixed(3)}</div>
    </div>
  `).join('');
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'device.coords.updated') {
        const i = state.devices.findIndex(d => String(d.id) === String(msg.device.id));
        if (i !== -1) state.devices[i] = msg.device;
        render();
      }
    } catch {}
  };
}