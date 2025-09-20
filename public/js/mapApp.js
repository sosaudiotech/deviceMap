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

// wait for layout/paint so getCTM()/getBBox() are reliable
async function afterPaint() {
    await new Promise(r => requestAnimationFrame(() => r()));
    await new Promise(r => requestAnimationFrame(() => r()));
}

// sanity-check: if computed box is tiny/huge vs the artboard, fall back
function saneBox(box, vb) {
    if (!box || box.width <= 0 || box.height <= 0) return vb;
    const ratio = (box.width * box.height) / (vb.width * vb.height);
    if (ratio < 0.02 || ratio > 1.10) return vb;
    return box;
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
    state.injected = injected;

    // predictable, responsive scaling on the floor SVG
    injected.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    injected.removeAttribute('width');
    injected.removeAttribute('height');
    markerLayer.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    
    // read root artboard
    const vbAttr = injected.getAttribute('viewBox') ||
        `0 0 ${injected.getAttribute('width')} ${injected.getAttribute('height')}`;
    const [minX, minY, width, height] = vbAttr.split(/\s+/).map(Number);
    state.svgViewBox = { minX, minY, width, height };

    // wait for paint, THEN compute content bounds
    await afterPaint();

    
    let geom = computeGeometryBBox(injected);
    if (!geom || geom.width <= 0 || geom.height <= 0) {
        try {
            const bb = injected.getBBox();
            geom = (bb && bb.width > 0 && bb.height > 0)
                ? { minX: bb.x, minY: bb.y, width: bb.width, height: bb.height }
                : null;
        } catch { geom = null; }
    }
    state.contentBox = saneBox(geom, state.svgViewBox);

    // init BOTH layers to the same artboard viewBox
    injected.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);   // 🔹 add this
    markerLayer.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
    ensureOverlayScaffold();

    // camera fit (padded effective box); applyView() will set both layers again
    setViewToBox(padBox(getEffectiveBox(), adaptivePadPct()));
    logBoxes('after fit');

    render();
}



// Robust geometry bounds in SVG coords (ignores <text>, unions transformed shapes)
function computeGeometryBBox(svgRoot) {
    const sels = 'path,rect,circle,ellipse,polyline,polygon,line';
    const nodes = svgRoot.querySelectorAll(sels);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    nodes.forEach(node => {
        try {
            const bb = node.getBBox();           // local bbox
            const m = node.getCTM();            // to root coords
            if (!bb || !m) return;

            // corners in local coords -> transform to root coords
            const corners = [
                { x: bb.x, y: bb.y },
                { x: bb.x + bb.width, y: bb.y },
                { x: bb.x, y: bb.y + bb.height },
                { x: bb.x + bb.width, y: bb.y + bb.height },
            ].map(p => {
                const pt = svgRoot.createSVGPoint();
                pt.x = p.x; pt.y = p.y;
                return pt.matrixTransform(m);
            });

            corners.forEach(p => {
                if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
                    if (p.x < minX) minX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y > maxY) maxY = p.y;
                }
            });
        } catch { }
    });

    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
    return { minX, minY, width: maxX - minX, height: maxY - minY };
}

function getEffectiveBox() {
    const vb = state.svgViewBox || { minX: 0, minY: 0, width: 100, height: 100 };
    const floor = state.floors.find(f => f.id === state.currentFloorId);
    if (floor?.box) return floor.box;           // manual override wins
    return saneBox(state.contentBox, vb);       // geometry if sane, else artboard
}

function setViewToBox(box) {
    state.view = { x: box.minX, y: box.minY, w: box.width, h: box.height };
    clampViewToBox(); // ensure inside padded clamp
    applyView();
}

function applyView() {
    if (!state.view) return;
    const { x, y, w, h } = state.view;
    if (state.injected) state.injected.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    markerLayer.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
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

    //console.log('#floor', state.injected.getBoundingClientRect());
    //console.log('#overlay', markerLayer.getBoundingClientRect());
    clampViewToBox();
    applyView();
    //assertAligned('after zoom/pan');
}

function panBy(dxScreen, dyScreen) {
    // convert screen delta -> SVG delta
    const p1 = svgPointFromClient(0, 0);
    const p2 = svgPointFromClient(dxScreen, dyScreen);
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    state.view.x -= dx;
    state.view.y -= dy;

    //console.log('#floor', state.injected.getBoundingClientRect());
    //console.log('#overlay', markerLayer.getBoundingClientRect());
    clampViewToBox();
    applyView();
    //assertAligned('after zoom/pan');
}


function render() {
  renderMarkers();
    renderList();
    drawDebugBoxes();
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
    const markers = ensureOverlayScaffold();   // <-- get persistent group
    const floorDevs = devicesForCurrentFloor();
    const box = getEffectiveBox();

    // build fresh nodes
    const frag = document.createDocumentFragment();
    floorDevs.forEach(dev => {
        const { x = 0.5, y = 0.5 } = dev.coords || {};
        const px = box.minX + x * box.width;
        const py = box.minY + y * box.height;
        frag.appendChild(markerNode(dev, px, py));
    });

    // swap contents without nuking <defs>
    markers.replaceChildren(frag);
}


function drawDebugBoxes() {
    // clear previous overlay (so it doesn’t stack)
    const old = markerLayer.querySelector('#debug-boxes');
    if (old) old.remove();

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('id', 'debug-boxes');

    const vb = state.svgViewBox;
    const eb = getEffectiveBox();
    const pad = adaptivePadPct();
    const pb = padBox(eb, pad);
    const v = state.view;

    function rect(box, stroke, dash = '4,3') {
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x', box.minX);
        r.setAttribute('y', box.minY);
        r.setAttribute('width', box.width);
        r.setAttribute('height', box.height);
        r.setAttribute('fill', 'none');
        r.setAttribute('stroke', stroke);
        r.setAttribute('stroke-dasharray', dash);
        r.setAttribute('stroke-width', '2');
        return r;
    }

    if (vb) g.appendChild(rect(vb, '#3aa3ff')); // blue: root viewBox/artboard
    if (eb) g.appendChild(rect(eb, '#2ecc71')); // green: effective content box
    if (pb) g.appendChild(rect(pb, '#f1c40f')); // yellow: padded clamp box
    if (v) g.appendChild(rect({ minX: v.x, minY: v.y, width: v.w, height: v.h }, '#e74c3c', '6,4')); // red: current camera

    // put it on top of markers
    markerLayer.appendChild(g);
}

function ensureOverlayScaffold() {
    // Add defs (icons) once
    if (!markerLayer.querySelector('#marker-defs')) {
        markerLayer.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns:xlink", "http://www.w3.org/1999/xlink");
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.id = 'marker-defs';
        defs.innerHTML = `
          <!-- define icons as <g> so <use> doesn't need width/height -->
          <g id="icon-display-land">
            <rect x="-22" y="-6" width="44" height="24" rx="2"/>
            
          </g>
          <g id="icon-display-port">
            <rect x="0" y="-16" width="24" height="44" rx="2"/>
            
          </g>
        `;

        markerLayer.appendChild(defs);
    }

    // Ensure a persistent group we can reuse
    let markers = markerLayer.querySelector('#markers');
    if (!markers) {
        markers = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        markers.id = 'markers';
        markerLayer.appendChild(markers);
    }
    return markers;
}                                 



function markerNode(dev, px, py) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.classList.add('marker');
    g.setAttribute('transform', `translate(${px}, ${py})`);

    const iconId = dev.orientation === 'portrait' ? '#icon-display-port' : '#icon-display-land';

    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', iconId);
    use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', iconId);
    use.setAttribute('transform', 'translate(-12,-12)');             // center 24x24 icon
    use.setAttribute('vector-effect', 'non-scaling-stroke');          // set as attribute (no VS warning)
    use.setAttribute('fill', getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5da9ff');
    use.setAttribute('opacity', '0.95');
    use.setAttribute('stroke', 'rgba(255,255,255,0.55)');
    use.setAttribute('stroke-width', '1.2');

    g.appendChild(use);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', '16');
    label.setAttribute('y', '4');
    label.setAttribute('pointer-events', 'none');
    label.textContent = dev.name || dev.id;
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

// Add near other helpers
function padBox(box, pct) {
    const pw = box.width * pct, ph = box.height * pct;
    return { minX: box.minX - pw, minY: box.minY - ph, width: box.width + 2 * pw, height: box.height + 2 * ph };
}

function adaptivePadPct() {
    const box = getEffectiveBox();
    const viewW = document.getElementById('map-wrapper').clientWidth || 1;
    const viewH = document.getElementById('map-wrapper').clientHeight || 1;
    const viewRatio = viewW / viewH;
    const boxRatio = box.width / box.height;

    // If the floor is much taller than the viewport (portrait in landscape),
    // give extra vertical slack so the bottom is easy to reach.
    if (boxRatio < viewRatio * 0.8) return 0.12;  // 12% pad
    return 0.04;                                   // default 4% pad
}

function clampViewToBox() {
    const base = getEffectiveBox();
    const box = padBox(base, adaptivePadPct());

    const v = state.view;

    // allow wider zoom range; tiny min so you can zoom way out if needed
    const minW = Math.max(1, base.width * 0.02);
    const minH = Math.max(1, base.height * 0.02);
    const maxW = base.width * 3.0;
    const maxH = base.height * 3.0;

    v.w = Math.max(minW, Math.min(maxW, v.w));
    v.h = Math.max(minH, Math.min(maxH, v.h));

    const maxX = box.minX + box.width - v.w;
    const maxY = box.minY + box.height - v.h;
    v.x = Math.max(box.minX, Math.min(maxX, v.x));
    v.y = Math.max(box.minY, Math.min(maxY, v.y));
}



const fitBtn = qs('#fit-btn');
const zoomInBtn = qs('#zoom-in-btn');
const zoomOutBtn = qs('#zoom-out-btn');
const mapWrapper = qs('#map-wrapper');

function wireZoomPanControls() {
    fitBtn?.addEventListener('click', () =>
        setViewToBox(padBox(getEffectiveBox(), adaptivePadPct()))
    );
    assertAligned('after fit');

    zoomInBtn?.addEventListener('click', () => zoomAt(mapWrapper.clientWidth / 2, mapWrapper.clientHeight / 2, 0.9));
    zoomOutBtn?.addEventListener('click', () => zoomAt(mapWrapper.clientWidth / 2, mapWrapper.clientHeight / 2, 1.1));

    let lastWheel = 0;
    mapWrapper.addEventListener('wheel', (e) => {
        e.preventDefault();
        const now = performance.now();
        if (now - lastWheel < 30) return;
        lastWheel = now;
        zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 0.9 : 1.1);
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
        mapWrapper.classList.add('panning');
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
        mapWrapper.classList.remove('panning');
        mapWrapper.releasePointerCapture(e.pointerId);
    });
}

function logBoxes(tag = '') {
    const vb = state.svgViewBox;
    const eb = getEffectiveBox();
    const pad = adaptivePadPct();
    const pb = padBox(eb, pad);
    const v = state.view;
    console.table({
        tag,
        viewBox: vb && `${vb.minX},${vb.minY} ${vb.width}×${vb.height}`,
        effective: eb && `${eb.minX},${eb.minY} ${eb.width}×${eb.height}`,
        padded: pb && `${pb.minX},${pb.minY} ${pb.width}×${pb.height} (pad ${Math.round(pad * 100)}%)`,
        camera: v && `${v.x},${v.y} ${v.w}×${v.h}`
    });
}

function assertAligned(tag = '') {
    const A = state.injected?.getScreenCTM();
    const B = markerLayer.getScreenCTM();
    if (!A || !B) return;

    const ok = (a, b) => Math.abs(a - b) < 0.5; // half pixel tolerance
    const same =
        ok(A.a, B.a) && ok(A.b, B.b) && ok(A.c, B.c) &&
        ok(A.d, B.d) && ok(A.e, B.e) && ok(A.f, B.f);

    if (!same) {
        console.warn('✗ VIEW MISMATCH', tag, { floor: A, overlay: B });
    } else {
        console.log('✓ view in sync', tag);
    }
}

