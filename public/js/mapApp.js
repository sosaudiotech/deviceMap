// public/js/mapApp.js
const qs = (sel, el = document) => el.querySelector(sel);
const qsa = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
    floors: [],
    devices: [],
    currentFloorId: null,
    admin: false,
    svgViewBox: null, // {minX,minY,width,height}
    contentBox: null,    // {minX,minY,width,height} of actual drawn content (auto via getBBox)
    view: null,       // {x,y,w,h} current camera viewBox
    injected: null    // reference to the injected floor <svg>

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
  wireZoomPanControls();
  connectWS();
  renderFloorSelect();
  autoPickFirstFloor();
}

function deviceKey(d) {
    return String(d?.id ?? d?.ip ?? d?.name ?? "");
}
function sameDevice(a, b) {
    return (a?.id && b?.id && String(a.id) === String(b.id)) ||
        (a?.ip && b?.ip && String(a.ip) === String(b.ip)) ||
        (a?.name && b?.name && String(a.name) === String(b.name));
}
function optimisticSetCoords(key, x, y) {
    const i = state.devices.findIndex(d => deviceKey(d) === String(key));
    if (i !== -1) {
        state.devices[i] = { ...state.devices[i], coords: { x, y } };
    }
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

  state.injected = injected;  // remember the root SVG element

  const vb = injected.getAttribute('viewBox') ||
             `0 0 ${injected.getAttribute('width')} ${injected.getAttribute('height')}`;
  const [minX, minY, width, height] = vb.split(/\s+/).map(Number);
  state.svgViewBox = { minX, minY, width, height };
    try {
        const bbox = injected.getBBox();
        if (bbox && isFinite(bbox.x) && isFinite(bbox.y) && bbox.width > 0 && bbox.height > 0) {
            state.contentBox = { minX: bbox.x, minY: bbox.y, width: bbox.width, height: bbox.height };
        } else {
            state.contentBox = null;
        }
    } catch {
        state.contentBox = null;
    }
  markerLayer.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
  markerLayer.setAttribute('preserveAspectRatio', injected.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
    // After we detect viewBox and contentBox:
    setViewToBox(getEffectiveBox()); // fit on load or floor change

}
function getEffectiveBox() {
    const vb = state.svgViewBox || { minX: 0, minY: 0, width: 100, height: 100 };
    const floor = state.floors.find(f => f.id === state.currentFloorId);
    if (floor?.box) return floor.box; // manual override from floors.json (optional)
    const cb = state.contentBox;
    if (cb && cb.width > 0 && cb.height > 0 && cb.width <= vb.width * 1.01 && cb.height <= vb.height * 1.01) return cb;
    return vb;
}

function setViewToBox(box) {
    state.view = { x: box.minX, y: box.minY, w: box.width, h: box.height };
    applyView();
}

function applyView() {
    if (!state.view) return;
    const { x, y, w, h } = state.view;
    if (state.injected) state.injected.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    markerLayer.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
}

function clampViewToBox() {
    const box = getEffectiveBox();
    const v = state.view;
    // clamp zoom extents (10% to 120% of content size)
    const minW = Math.max(1, box.width * 0.1);
    const minH = Math.max(1, box.height * 0.1);
    const maxW = box.width * 1.2;
    const maxH = box.height * 1.2;

    v.w = Math.max(minW, Math.min(maxW, v.w));
    v.h = Math.max(minH, Math.min(maxH, v.h));

    // clamp position so view stays within content box
    const maxX = box.minX + box.width - v.w;
    const maxY = box.minY + box.height - v.h;
    v.x = Math.max(box.minX, Math.min(maxX, v.x));
    v.y = Math.max(box.minY, Math.min(maxY, v.y));
}

function zoomAt(clientX, clientY, factor) {
    // keep the svg point under cursor stationary while zooming
    const p = svgPointFromClient(clientX, clientY);
    const v = state.view;
    const nx = p.x - (p.x - v.x) * factor;
    const ny = p.y - (p.y - v.y) * factor;
    const nw = v.w * factor;
    const nh = v.h * factor;

    state.view = { x: nx, y: ny, w: nw, h: nh };
    clampViewToBox();
    applyView();
}

function panBy(dxScreen, dyScreen) {
    // convert screen delta -> SVG delta
    const p1 = svgPointFromClient(0, 0);
    const p2 = svgPointFromClient(dxScreen, dyScreen);
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    state.view.x -= dx;
    state.view.y -= dy;
    clampViewToBox();
    applyView();
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
    const box = getEffectiveBox();
    const px = box.minX + x * box.width;
    const py = box.minY + y * box.height;


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
        const box = getEffectiveBox();

        const normX = clamp01((parseFloat(tx) - box.minX) / box.width);
        const normY = clamp01((parseFloat(ty) - box.minY) / box.height);

        // 🔑 stable identifier (id || ip || name)
        const key = deviceKey(dev);

        // 1) Optimistic local update so the marker stays put
        optimisticSetCoords(key, normX, normY);
        render();

        // 2) Persist to server
        try {
            await saveCoords(key, normX, normY);
        } catch (err) {
            console.error('saveCoords failed', err);
            // (Optional) revert or show a toast here
        }
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
     const i = state.devices.findIndex(d => sameDevice(d, msg.device));
     if (i !== -1) {
           // Shallow-merge so we don’t lose extra fields
               state.devices[i] = { ...state.devices[i], ...msg.device };
         } else {
           state.devices.push(msg.device);
                   }
        render();
      }
    } catch {}
  };
}



const fitBtn = qs('#fit-btn');
const zoomInBtn = qs('#zoom-in-btn');
const zoomOutBtn = qs('#zoom-out-btn');
const mapWrapper = qs('#map-wrapper');

function wireZoomPanControls() {
    fitBtn?.addEventListener('click', () => setViewToBox(getEffectiveBox()));
    zoomInBtn?.addEventListener('click', () => zoomAt(mapWrapper.clientWidth / 2, mapWrapper.clientHeight / 2, 0.9));
    zoomOutBtn?.addEventListener('click', () => zoomAt(mapWrapper.clientWidth / 2, mapWrapper.clientHeight / 2, 1.1));

    // Scroll to zoom (around mouse position)
    mapWrapper.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 0.9 : 1.1;
        zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });

    // Hold Space and drag to pan
    let spaceDown = false;
    let isPanning = false;
    let lastX = 0, lastY = 0;

    window.addEventListener('keydown', (e) => { if (e.code === 'Space') spaceDown = true; });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });

    mapWrapper.addEventListener('pointerdown', (e) => {
        // begin pan only when Space is held (so marker dragging still works)
        if (!spaceDown) return;
        isPanning = true;
        lastX = e.clientX; lastY = e.clientY;
        mapWrapper.setPointerCapture(e.pointerId);
    });

    mapWrapper.addEventListener('pointermove', (e) => {
        if (!isPanning) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        panBy(dx, dy);
    });

    mapWrapper.addEventListener('pointerup', (e) => {
        if (!isPanning) return;
        isPanning = false;
        mapWrapper.releasePointerCapture(e.pointerId);
    });
}
