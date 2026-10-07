/* Fire Extinguisher Survey PWA
 * All data is stored on the device in IndexedDB. No server is needed.
 */
'use strict';

const DUE_DAYS = 30;
const OPERATOR_KEY = 'fe.operator';
const FILTER_KEY = 'fe.filter';
const UNIT_KEY = 'fe.unit';
const SEED_KEY = 'fe.seedVersion';

const ISSUES = [
  ['corroded', 'Corroded / rusted'],
  ['damaged', 'Damaged / dented'],
  ['casing', 'Needs casing / cabinet'],
  ['pressure', 'Low pressure'],
  ['pin', 'Safety pin or seal missing'],
  ['hose', 'Hose or nozzle damaged'],
  ['label', 'Label unreadable'],
  ['access', 'Access blocked'],
  ['refill', 'Needs refill'],
  ['service', 'Service overdue'],
  ['bracket', 'Bracket damaged'],
  ['missing', 'Missing from location'],
  ['other', 'Other'],
];
const ISSUE_LABEL = Object.fromEntries(ISSUES);

const TYPES = ['Ansul ABC/C', 'CO2', 'Wheeled Type', 'Dry powder (ABC)', 'Dry powder (BC)', 'Foam (AFFF)', 'Water', 'Wet chemical', 'Clean agent (FM-200)'];
const CAPACITIES = ['10 LBS', '15 LBS', '17 LBS', '20 LBS', '25 LBS', '27 LBS', '30 LBS', '125 LBS', '150 LBS', '2 KG', '6 KG', '10 KG'];

/* ---------------- helpers ---------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function normCode(code) {
  return String(code ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function storageGet(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function relDays(iso) {
  const n = daysSince(iso);
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  return `${n} days ago`;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function localDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function localTime(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

function go(hash, replace = false) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

function extHash(code, suffix = '') {
  return `#/ext/${encodeURIComponent(code)}${suffix}`;
}

/** Display title: imported extinguishers have no name, so fall back to the location. */
function title(ext) {
  return ext.name || ext.location || ext.code;
}

/** Normalised label text; must match label_key() in tools/import_register.py. */
function labelKey(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Read the plant's label format: "UNIT: …\nID NO: …\nLOCATION: …\nTYPE: …\nSIZE: …". */
function parsePlantLabel(text) {
  if (!/ID\s*NO\s*:/i.test(text)) return null;
  const field = (name) => (text.match(new RegExp(`^\\s*${name}\\s*:[ \\t]*(.*)$`, 'im')) || [])[1]?.trim() ?? '';
  return {
    tag: normCode(field('ID\\s*NO')) || 'NO TAG',
    unit: field('UNIT').replace(/\s+/g, ' '),
    location: field('LOCATION').replace(/\s+/g, ' '),
    type: field('TYPE').replace(/\s+/g, ' '),
    capacity: field('SIZE').replace(/\s+/g, ' '),
  };
}

/**
 * Work out which extinguisher(s) scanned or typed text refers to. Accepts a link made by this app,
 * the plant's multi-line label text, or a plain code / ID number.
 * Returns { matches: [ext…], code, label } where label holds the parsed plant label fields, if any.
 */
async function resolveScan(text) {
  const raw = String(text ?? '').trim();
  const link = raw.match(/#\/ext\/([^/?#]+)/);
  if (link) {
    let code;
    try { code = normCode(decodeURIComponent(link[1])); } catch { code = normCode(link[1]); }
    const ext = await DB.getExt(code);
    return { matches: ext ? [ext] : [], code };
  }
  const all = await DB.allExt();
  const label = parsePlantLabel(raw);
  if (label) {
    const key = labelKey(raw);
    let matches = all.filter((e) => e.labelKey === key);
    if (!matches.length) matches = all.filter((e) => (e.tag || e.code) === label.tag);
    return { matches, code: label.tag, label, key };
  }
  const code = normCode(raw);
  const exact = all.filter((e) => e.code === code);
  return { matches: exact.length ? exact : all.filter((e) => e.tag === code), code };
}

let pendingScan = null; // carries a scan result to the picker / register views

async function openScan(text) {
  const res = await resolveScan(text);
  if (!res.code) return;
  if (res.matches.length === 1) { go(extHash(res.matches[0].code), true); return; }
  pendingScan = res;
  go(res.matches.length ? '#/pick' : extHash(res.code), true);
}

function labelUrl(code) {
  return `${location.origin}${location.pathname}${extHash(code)}`;
}

/* ---------------- database ---------------- */

const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('fe-survey', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('extinguishers', { keyPath: 'code' });
        const s = db.createObjectStore('surveys', { keyPath: 'id' });
        s.createIndex('code', 'code');
      };
      req.onsuccess = () => { this.db = req.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  },
  async run(store, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      const r = fn(tx);
      if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  getExt(code) { return this.run('extinguishers', 'readonly', (tx) => tx.objectStore('extinguishers').get(code)); },
  allExt() { return this.run('extinguishers', 'readonly', (tx) => tx.objectStore('extinguishers').getAll()); },
  putExt(ext) { return this.run('extinguishers', 'readwrite', (tx) => tx.objectStore('extinguishers').put(ext)); },
  allSurveys() { return this.run('surveys', 'readonly', (tx) => tx.objectStore('surveys').getAll()); },
  surveysFor(code) {
    return this.run('surveys', 'readonly', (tx) => tx.objectStore('surveys').index('code').getAll(code))
      .then((list) => list.sort((a, b) => b.date.localeCompare(a.date)));
  },
  putSurvey(s) { return this.run('surveys', 'readwrite', (tx) => tx.objectStore('surveys').put(s)); },
  deleteSurvey(id) { return this.run('surveys', 'readwrite', (tx) => tx.objectStore('surveys').delete(id)); },
  deleteExt(code) {
    return this.run(['extinguishers', 'surveys'], 'readwrite', (tx) => {
      tx.objectStore('extinguishers').delete(code);
      const idx = tx.objectStore('surveys').index('code');
      idx.openKeyCursor(IDBKeyRange.only(code)).onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) { tx.objectStore('surveys').delete(cur.primaryKey); cur.continue(); }
      };
    });
  },
  importAll(exts, surveys) {
    return this.run(['extinguishers', 'surveys'], 'readwrite', (tx) => {
      exts.forEach((e) => tx.objectStore('extinguishers').put(e));
      surveys.forEach((s) => tx.objectStore('surveys').put(s));
    });
  },
};

/** Extinguishers joined with their latest survey and due state. */
async function loadOverview() {
  const [exts, surveys] = await Promise.all([DB.allExt(), DB.allSurveys()]);
  const last = {};
  for (const s of surveys) {
    if (!last[s.code] || s.date > last[s.code].date) last[s.code] = s;
  }
  return exts.map((e) => {
    const l = last[e.code] || null;
    return { ...e, last: l, due: !l || daysSince(l.date) > DUE_DAYS };
  });
}

/* ---------------- shell / routing ---------------- */

let cleanup = null; // called when leaving a view (stops the camera etc.)

const routes = [
  [/^#?\/?$/, () => viewHome()],
  [/^#\/scan$/, () => viewScan()],
  [/^#\/pick$/, () => viewPick()],
  [/^#\/new(?:\?code=(.*))?$/, (m) => viewEditor(null, m[1] ? decodeURIComponent(m[1]) : '')],
  [/^#\/ext\/([^/]+)$/, (m) => viewExt(decodeURIComponent(m[1]))],
  [/^#\/ext\/([^/]+)\/survey$/, (m) => viewSurvey(decodeURIComponent(m[1]))],
  [/^#\/ext\/([^/]+)\/edit$/, (m) => viewEditor(decodeURIComponent(m[1]))],
  [/^#\/ext\/([^/]+)\/label$/, (m) => viewLabel(decodeURIComponent(m[1]))],
];

function setShell(title, backHash) {
  $('#title').textContent = title;
  document.title = title === 'Extinguishers' ? 'Fire Extinguisher Survey' : `${title} · FE Survey`;
  const back = $('#backBtn');
  back.hidden = !backHash;
  back.onclick = () => go(backHash, true);
}

async function router() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  closeMenu();
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try { await fn(m); } catch (err) { console.error(err); render(`<p class="pad error">Something went wrong: ${esc(err.message)}</p>`); }
      $('#view').focus({ preventScroll: true });
      window.scrollTo(0, 0);
      return;
    }
  }
  go('#/', true);
}

function render(html) { $('#view').innerHTML = html; }

/* ---------------- home ---------------- */

async function viewHome() {
  setShell('Extinguishers', null);
  const items = await loadOverview();
  let filter = storageGet(FILTER_KEY, 'all');
  const units = [...new Set(items.map((i) => i.unit).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  let unit = storageGet(UNIT_KEY, '');
  if (!units.includes(unit)) unit = '';

  render(`
    <section class="stats">
      <button class="stat" data-filter="all"><span class="num" id="nTotal"></span><span>Total</span></button>
      <button class="stat bad" data-filter="notok"><span class="num" id="nNotOk"></span><span>Not OK</span></button>
      <button class="stat warn" data-filter="due"><span class="num" id="nDue"></span><span>Due (&gt;${DUE_DAYS} days)</span></button>
    </section>
    <div class="searchbar">
      <input type="search" id="search" placeholder="Search ID, unit, location, type" aria-label="Search" autocomplete="off">
      ${units.length ? `<select id="unitSel" aria-label="Unit">
        <option value="">All units / areas</option>
        ${units.map((u) => `<option value="${esc(u)}"${u === unit ? ' selected' : ''}>${esc(u)}</option>`).join('')}
      </select>` : ''}
    </div>
    <div class="chips" role="tablist">
      ${[['all', 'All'], ['notok', 'Not OK'], ['due', 'Due'], ['ok', 'OK'], ['never', 'Never checked']]
        .map(([k, l]) => `<button class="chip" role="tab" data-filter="${k}">${l}</button>`).join('')}
    </div>
    <ul class="list" id="list"></ul>
    <div class="fabs">
      <a class="fab small" href="#/new" aria-label="Add extinguisher" title="Add extinguisher">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </a>
      <a class="fab" href="#/scan">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/></svg>
        <span>Scan QR code</span>
      </a>
    </div>
  `);

  const sortKey = (i) => (i.last && i.last.result === 'NOT_OK' ? 0 : i.due ? 1 : 2);
  // Within each status group keep the register's order (the walking route); hand-added ones go last.
  const order = (i) => i.order ?? Infinity;
  items.sort((a, b) => sortKey(a) - sortKey(b) || order(a) - order(b) || a.code.localeCompare(b.code, undefined, { numeric: true }));

  const draw = () => {
    const q = $('#search').value.trim().toLowerCase();
    const inUnit = unit ? items.filter((i) => i.unit === unit) : items;
    $('#nTotal').textContent = inUnit.length;
    $('#nNotOk').textContent = inUnit.filter((i) => i.last && i.last.result === 'NOT_OK').length;
    $('#nDue').textContent = inUnit.filter((i) => i.due).length;
    $$('[data-filter]').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
    const shown = inUnit.filter((i) => {
      if (filter === 'notok' && !(i.last && i.last.result === 'NOT_OK')) return false;
      if (filter === 'due' && !i.due) return false;
      if (filter === 'ok' && !(i.last && i.last.result === 'OK')) return false;
      if (filter === 'never' && i.last) return false;
      if (!q) return true;
      return [i.name, i.code, i.tag, i.unit, i.location, i.type, i.capacity].some((f) => String(f || '').toLowerCase().includes(q));
    });
    const list = $('#list');
    if (!items.length) {
      list.innerHTML = `<li class="empty">
        <p><strong>No extinguishers yet.</strong></p>
        <p>Scan a label to register it, or tap <strong>+</strong> to add one by hand.</p>
        <button class="btn ghost" id="sampleBtn">Add sample extinguishers</button></li>`;
      $('#sampleBtn').onclick = addSamples;
      return;
    }
    if (!shown.length) { list.innerHTML = '<li class="empty">No extinguishers match.</li>'; return; }
    list.innerHTML = shown.map((i) => `
      <li><a class="row" href="${extHash(i.code)}">
        <div class="row-main">
          <div class="row-title">${esc(title(i))}</div>
          <div class="row-sub">${esc(subtitle(i))}</div>
          <div class="row-sub">${i.last ? `Checked ${esc(relDays(i.last.date))}${i.last.operator ? ' by ' + esc(i.last.operator) : ''}` : 'Never checked'}</div>
        </div>
        <div class="row-badges">
          ${statusBadge(i.last)}
          ${i.due ? '<span class="badge warn">Due</span>' : ''}
        </div>
      </a></li>`).join('');
  };

  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    storageSet(FILTER_KEY, filter);
    draw();
  }));
  $('#unitSel')?.addEventListener('change', (e) => {
    unit = e.target.value;
    storageSet(UNIT_KEY, unit);
    draw();
  });
  $('#search').addEventListener('input', draw);
  draw();
}

/** Second line under the title: code, plus whatever of unit/location the title doesn't already show. */
function subtitle(ext) {
  const t = title(ext);
  return [ext.code, ext.unit, ext.location].filter((v, i) => v && (i === 0 || v !== t)).join(' · ');
}

function statusBadge(last) {
  if (!last) return '<span class="badge muted">No check</span>';
  return last.result === 'OK' ? '<span class="badge ok">OK</span>' : '<span class="badge bad">NOT OK</span>';
}

async function addSamples() {
  const now = Date.now();
  const day = 86400000;
  const exts = [
    { code: 'FE-001', name: 'Turbine Hall North', location: 'Unit 1 turbine hall, column A3', type: 'CO2', capacity: '5 kg' },
    { code: 'FE-002', name: 'Control Room', location: 'Main control room, by door 2', type: 'Clean agent (FM-200)', capacity: '6 kg' },
    { code: 'FE-003', name: 'Boiler Feed Pump', location: 'Pump house, bay 4', type: 'Dry powder (ABC)', capacity: '9 kg' },
    { code: 'FE-004', name: 'Transformer Yard', location: 'Yard gate, GT-2', type: 'Dry powder (ABC)', capacity: '50 kg' },
  ].map((e) => ({ ...e, notes: '', createdAt: new Date(now - 90 * day).toISOString() }));
  const surveys = [
    { code: 'FE-001', date: new Date(now - 3 * day).toISOString(), operator: 'A. Hassan', result: 'OK', issues: [], otherNote: '', notes: '' },
    { code: 'FE-002', date: new Date(now - 10 * day).toISOString(), operator: 'M. Ali', result: 'NOT_OK', issues: ['pressure', 'label'], otherNote: '', notes: 'Gauge in red zone.' },
    { code: 'FE-003', date: new Date(now - 45 * day).toISOString(), operator: 'A. Hassan', result: 'OK', issues: [], otherNote: '', notes: '' },
  ].map((s) => ({ ...s, id: uid() }));
  await DB.importAll(exts, surveys);
  toast('Sample extinguishers added');
  router();
}

/* ---------------- scanner ---------------- */

async function viewScan() {
  setShell('Scan QR code', '#/');
  render(`
    <section class="scanner">
      <div class="video-wrap">
        <video id="video" playsinline muted></video>
        <div class="reticle" aria-hidden="true"></div>
        <p class="scan-msg" id="scanMsg">Starting camera…</p>
      </div>
      <div class="scan-actions">
        <button class="btn ghost" id="torchBtn" aria-pressed="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2h6l-1 6h-4zM10 8h4v3l-1 11h-2l-1-11z"/></svg>
          Flashlight
        </button>
      </div>
    </section>
    <form class="card manual" id="manualForm">
      <label for="manualCode">Label damaged? Type the ID number</label>
      <div class="inline">
        <input id="manualCode" placeholder="ID number, e.g. GPP1-01-012" autocomplete="off" autocapitalize="characters" required>
        <button class="btn primary" type="submit">Open</button>
      </div>
    </form>
  `);

  $('#manualForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#manualCode').value.trim();
    if (text) openScan(text);
  });

  const video = $('#video');
  const msg = $('#scanMsg');
  let stream = null;
  let stopped = false;
  let raf = 0;
  let torchOn = false;
  cleanup = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
  };

  if (!navigator.mediaDevices?.getUserMedia) {
    msg.textContent = window.isSecureContext
      ? 'Camera is not available in this browser. Type the code below.'
      : 'Camera needs a secure (https) connection. Type the code below.';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    msg.textContent = err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow it in the browser settings, or type the code below.'
      : 'Could not start the camera. Type the code below.';
    return;
  }
  if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
  video.srcObject = stream;
  await video.play().catch(() => {});
  msg.textContent = 'Point the camera at the QR label';

  const track = stream.getVideoTracks()[0];
  $('#torchBtn').addEventListener('click', async () => {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.torch) { toast('Flashlight is not available on this device or browser'); return; }
    torchOn = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: torchOn }] });
      $('#torchBtn').setAttribute('aria-pressed', String(torchOn));
      $('#torchBtn').classList.toggle('on', torchOn);
    } catch {
      torchOn = !torchOn;
      toast('Could not switch the flashlight');
    }
  });

  let detector = null;
  if ('BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch { detector = null; }
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let busy = false;
  let lastRun = 0;

  const found = (text) => {
    if (!String(text).trim()) return;
    cleanup();
    if (navigator.vibrate) navigator.vibrate(80);
    openScan(text);
  };

  const tick = async (t) => {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (busy || t - lastRun < 150 || video.readyState < 2) return;
    busy = true;
    lastRun = t;
    try {
      if (detector) {
        const codes = await detector.detect(video);
        if (codes.length && codes[0].rawValue) found(codes[0].rawValue);
      } else if (window.jsQR) {
        const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
        if (res && res.data) found(res.data);
      }
    } catch (err) {
      console.warn(err);
    } finally {
      busy = false;
    }
  };
  raf = requestAnimationFrame(tick);
}

/* ---------------- extinguisher detail ---------------- */

async function viewExt(rawCode) {
  const code = normCode(rawCode);
  const ext = await DB.getExt(code);
  if (!ext) return viewUnknown(code);
  setShell(title(ext), '#/');
  const surveys = await DB.surveysFor(code);
  const last = surveys[0];
  const age = last ? daysSince(last.date) : null;

  let warning = '';
  if (!last) warning = '<div class="alert warn">This extinguisher has never been checked.</div>';
  else if (age > DUE_DAYS) warning = `<div class="alert warn">More than ${DUE_DAYS} days since the last check (${age} days). A check is due.</div>`;

  render(`
    ${warning}
    <section class="card">
      <h2 class="ext-name">${esc(title(ext))}</h2>
      <dl class="facts">
        <dt>ID No</dt><dd class="mono">${esc(ext.tag || ext.code)}</dd>
        ${ext.tag && ext.tag !== ext.code ? `<dt>App code</dt><dd class="mono">${esc(ext.code)}</dd>` : ''}
        <dt>Unit</dt><dd>${esc(ext.unit) || '—'}</dd>
        <dt>Location</dt><dd>${esc(ext.location) || '—'}</dd>
        <dt>Type</dt><dd>${esc(ext.type) || '—'}</dd>
        <dt>Size</dt><dd>${esc(ext.capacity) || '—'}</dd>
        ${ext.notes ? `<dt>Notes</dt><dd>${esc(ext.notes)}</dd>` : ''}
      </dl>
    </section>

    <section class="card">
      <h3>Last check</h3>
      ${last ? surveyBlock(last, true) : '<p class="muted">No checks recorded yet.</p>'}
    </section>

    <a class="btn primary big block" href="${extHash(code, '/survey')}">Record survey</a>
    <div class="btn-row">
      <a class="btn ghost" href="${extHash(code, '/label')}">QR label</a>
      <a class="btn ghost" href="${extHash(code, '/edit')}">Edit</a>
    </div>

    <section class="card">
      <h3>History <span class="muted">(${surveys.length})</span></h3>
      ${surveys.length ? `<ol class="history">${surveys.map((s) => `
        <li>${surveyBlock(s, false)}
          <button class="link danger" data-del="${esc(s.id)}">Delete</button></li>`).join('')}</ol>`
        : '<p class="muted">No history yet.</p>'}
    </section>
  `);

  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this survey record?')) return;
    await DB.deleteSurvey(b.dataset.del);
    toast('Survey deleted');
    router();
  }));
}

function surveyBlock(s, large) {
  const issues = (s.issues || []).map((k) => (k === 'other' && s.otherNote ? `Other: ${s.otherNote}` : ISSUE_LABEL[k] || k));
  return `
    <div class="survey ${large ? 'large' : ''}">
      <div class="survey-head">
        ${statusBadge(s)}
        <span class="survey-date">${esc(fmtDateTime(s.date))}</span>
      </div>
      <div class="muted">By ${esc(s.operator || 'unknown')} · ${esc(relDays(s.date))}</div>
      ${issues.length ? `<ul class="issues">${issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
      ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
    </div>`;
}

function viewUnknown(code) {
  setShell('Unknown code', '#/');
  const label = pendingScan && pendingScan.code === code ? pendingScan.label : null;
  render(`
    <section class="card center">
      <p class="big-code mono">${esc(code)}</p>
      ${label ? `<p class="muted">${esc([label.unit, label.location, label.type, label.capacity].filter(Boolean).join(' · '))}</p>` : ''}
      <p>This extinguisher is not registered in the app yet.</p>
      <a class="btn primary big block" href="#/new?code=${encodeURIComponent(code)}">Register this extinguisher</a>
      <a class="btn ghost block" href="#/scan">Scan again</a>
    </section>
  `);
}

/** More than one extinguisher shares the scanned ID / label text: let the operator choose. */
function viewPick() {
  const res = pendingScan;
  if (!res || !res.matches?.length) { go('#/', true); return; }
  setShell('Which extinguisher?', '#/scan');
  render(`
    <div class="alert warn">${res.matches.length} extinguishers share ID ${esc(res.code)}. Choose the one in front of you.</div>
    <ul class="list">
      ${res.matches.map((e) => `<li><a class="row" href="${extHash(e.code)}">
        <div class="row-main">
          <div class="row-title">${esc(e.unit ? `${e.unit} — ${e.location || ''}` : title(e))}</div>
          <div class="row-sub">${esc([e.code, e.type, e.capacity].filter(Boolean).join(' · '))}</div>
        </div></a></li>`).join('')}
    </ul>
  `);
}

/* ---------------- survey form ---------------- */

async function viewSurvey(rawCode) {
  const code = normCode(rawCode);
  const ext = await DB.getExt(code);
  if (!ext) return viewUnknown(code);
  setShell('Record survey', extHash(code));

  render(`
    <section class="card compact">
      <div class="row-title">${esc(title(ext))}</div>
      <div class="row-sub">${esc(subtitle(ext))}</div>
    </section>
    <form id="surveyForm" class="card" novalidate>
      <fieldset>
        <legend>Condition</legend>
        <div class="result-toggle">
          <label class="result ok"><input type="radio" name="result" value="OK"><span>✓ OK</span></label>
          <label class="result bad"><input type="radio" name="result" value="NOT_OK"><span>✗ NOT OK</span></label>
        </div>
      </fieldset>

      <fieldset id="issuesSet" hidden>
        <legend>What is wrong? <span class="muted">(tick all that apply)</span></legend>
        <div class="issues-grid">
          ${ISSUES.map(([k, l]) => `<label class="check"><input type="checkbox" name="issue" value="${k}"><span>${esc(l)}</span></label>`).join('')}
        </div>
        <div id="otherWrap" hidden>
          <label for="otherNote">Describe the other problem <span class="req">*</span></label>
          <input id="otherNote" maxlength="200">
        </div>
      </fieldset>

      <label for="notes">Notes <span class="muted">(optional)</span></label>
      <textarea id="notes" rows="3" maxlength="1000"></textarea>

      <label for="operator">Operator name <span class="req">*</span></label>
      <input id="operator" autocomplete="name" required value="${esc(storageGet(OPERATOR_KEY))}">

      <p class="error" id="formError" role="alert" hidden></p>
      <button class="btn primary big block" type="submit">Save survey</button>
    </form>
  `);

  const form = $('#surveyForm');
  const syncVisibility = () => {
    const result = form.result.value;
    $('#issuesSet').hidden = result !== 'NOT_OK';
    $('#otherWrap').hidden = !$('input[name="issue"][value="other"]').checked;
  };
  form.addEventListener('change', syncVisibility);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#formError');
    const result = form.result.value;
    const issues = result === 'NOT_OK' ? $$('input[name="issue"]:checked').map((c) => c.value) : [];
    const otherNote = issues.includes('other') ? $('#otherNote').value.trim() : '';
    const operator = $('#operator').value.trim();
    let problem = '';
    if (!result) problem = 'Choose OK or NOT OK.';
    else if (result === 'NOT_OK' && !issues.length) problem = 'Tick at least one problem.';
    else if (issues.includes('other') && !otherNote) problem = 'Describe the "Other" problem.';
    else if (!operator) problem = 'Enter your name.';
    if (problem) { err.textContent = problem; err.hidden = false; err.scrollIntoView({ block: 'center' }); return; }

    await DB.putSurvey({
      id: uid(), code, date: new Date().toISOString(), operator, result, issues, otherNote,
      notes: $('#notes').value.trim(),
    });
    storageSet(OPERATOR_KEY, operator);
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    toast('Survey saved');
    go(extHash(code), true);
  });
}

/* ---------------- add / edit extinguisher ---------------- */

async function viewEditor(rawCode, prefill = '') {
  const editing = rawCode != null;
  const code = editing ? normCode(rawCode) : normCode(prefill);
  const ext = editing ? await DB.getExt(code) : null;
  if (editing && !ext) return viewUnknown(code);
  setShell(editing ? 'Edit extinguisher' : 'Add extinguisher', editing ? extHash(code) : '#/');
  // A scanned plant label that isn't registered yet pre-fills the form.
  const scanned = !editing && pendingScan && pendingScan.code === code ? pendingScan : null;
  const label = scanned?.label || {};
  const v = ext || { code, name: '', unit: label.unit || '', location: label.location || '', type: label.type || '', capacity: label.capacity || '', notes: '' };

  render(`
    <form id="extForm" class="card" novalidate>
      <label for="fCode">ID number (as on the label) <span class="req">*</span></label>
      <input id="fCode" class="mono" value="${esc(v.code)}" ${editing ? 'readonly' : ''} required autocomplete="off" autocapitalize="characters" placeholder="e.g. GPP1-01-012">

      <label for="fName">Name <span class="muted">(optional)</span></label>
      <input id="fName" value="${esc(v.name)}" placeholder="Shown instead of the location, e.g. Turbine Hall North">

      <label for="fUnit">Unit / area</label>
      <input id="fUnit" list="unitList" value="${esc(v.unit)}" placeholder="e.g. Unit 2">
      <datalist id="unitList"></datalist>

      <label for="fLocation">Location</label>
      <input id="fLocation" value="${esc(v.location)}" placeholder="e.g. Unit 2 - Level 3">

      <div class="two">
        <div>
          <label for="fType">Type</label>
          <input id="fType" list="typeList" value="${esc(v.type)}" placeholder="e.g. CO2">
        </div>
        <div>
          <label for="fCapacity">Size</label>
          <input id="fCapacity" list="capList" value="${esc(v.capacity)}" placeholder="e.g. 25 LBS">
        </div>
      </div>
      <datalist id="typeList">${TYPES.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <datalist id="capList">${CAPACITIES.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>

      <label for="fNotes">Notes</label>
      <textarea id="fNotes" rows="2">${esc(v.notes)}</textarea>

      <p class="error" id="formError" role="alert" hidden></p>
      <button class="btn primary big block" type="submit">${editing ? 'Save changes' : 'Add extinguisher'}</button>
      ${editing ? '<button class="btn danger block" type="button" id="deleteBtn">Delete extinguisher</button>' : ''}
    </form>
  `);
  if (!editing) $(code ? '#fUnit' : '#fCode').focus();
  DB.allExt().then((all) => {
    const units = [...new Set(all.map((e) => e.unit).filter(Boolean))].sort();
    $('#unitList').innerHTML = units.map((u) => `<option value="${esc(u)}">`).join('');
  });

  $('#extForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#formError');
    const newCode = normCode($('#fCode').value);
    const name = $('#fName').value.trim();
    const location = $('#fLocation').value.trim();
    let problem = '';
    if (!newCode) problem = 'Enter the ID number.';
    else if (!name && !location) problem = 'Enter a location (or a name).';
    else if (!editing && await DB.getExt(newCode)) problem = `${newCode} is already registered.`;
    if (problem) { err.textContent = problem; err.hidden = false; return; }

    await DB.putExt({
      ...ext,
      code: newCode,
      tag: ext?.tag || newCode,
      labelKey: ext?.labelKey || (scanned?.label ? scanned.key : ''),
      name,
      unit: $('#fUnit').value.trim(),
      location,
      type: $('#fType').value.trim(),
      capacity: $('#fCapacity').value.trim(),
      notes: $('#fNotes').value.trim(),
      createdAt: ext?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    pendingScan = null;
    toast(editing ? 'Changes saved' : 'Extinguisher added');
    go(extHash(newCode), true);
  });

  if (editing) {
    $('#deleteBtn').addEventListener('click', async () => {
      if (!confirm(`Delete ${title(ext)} (${ext.code}) and all of its survey history?`)) return;
      await DB.deleteExt(code);
      toast('Extinguisher deleted');
      go('#/', true);
    });
  }
}

/* ---------------- QR label ---------------- */

function drawLabel(ext) {
  const qr = qrcode(0, 'M');
  qr.addData(labelUrl(ext.code));
  qr.make();
  const n = qr.getModuleCount();

  const W = 700;
  const margin = 40;
  const qrSize = W - margin * 2;
  const cell = qrSize / (n + 8); // 4-module quiet zone on each side
  const headerH = 90;
  const textTop = headerH + qrSize + 10;
  const H = textTop + 210;

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#c62828'; g.lineWidth = 8; g.strokeRect(4, 4, W - 8, H - 8);

  g.fillStyle = '#c62828'; g.fillRect(0, 0, W, headerH);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 40px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  g.fillText('FIRE EXTINGUISHER', W / 2, headerH / 2);

  g.fillStyle = '#000';
  const ox = margin + cell * 4;
  const oy = headerH + cell * 4;
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(r, col)) g.fillRect(Math.floor(ox + col * cell), Math.floor(oy + r * cell), Math.ceil(cell), Math.ceil(cell));
    }
  }

  const fit = (text, font, maxSize, y, weight = '') => {
    let size = maxSize;
    do { g.font = `${weight} ${size}px ${font}`; size -= 2; } while (g.measureText(text).width > W - margin * 2 && size > 14);
    g.fillText(text, W / 2, y);
  };
  g.fillStyle = '#000';
  fit(ext.code, 'ui-monospace, Menlo, Consolas, monospace', 56, textTop + 40, 'bold');
  fit(title(ext), 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', 38, textTop + 105, 'bold');
  g.fillStyle = '#333';
  fit([ext.unit, ext.location].filter((v) => v && v !== title(ext)).join(' · '), 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', 30, textTop + 160);
  return c;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function safeFileName(s) {
  return String(s).replace(/[^\w.-]+/g, '_');
}

async function viewLabel(rawCode) {
  const code = normCode(rawCode);
  const ext = await DB.getExt(code);
  if (!ext) return viewUnknown(code);
  setShell('QR label', extHash(code));
  if (typeof qrcode !== 'function') { render('<p class="pad error">QR generator failed to load.</p>'); return; }

  const canvas = drawLabel(ext);
  const dataUrl = canvas.toDataURL('image/png');
  render(`
    <section class="label-wrap">
      <img id="labelImg" class="label-img" src="${dataUrl}" alt="QR label for ${esc(title(ext))} (${esc(ext.code)})">
    </section>
    <div class="btn-row three">
      <button class="btn primary" id="shareBtn">Share</button>
      <button class="btn ghost" id="dlBtn">Download</button>
      <button class="btn ghost" id="printBtn">Print</button>
    </div>
    <p class="muted small pad">The QR code holds the extinguisher code (${esc(ext.code)}) inside a link to this app,
      so it can be scanned in the app or opened with the phone's camera.</p>
  `);

  const fileName = `label_${safeFileName(ext.code)}.png`;
  $('#shareBtn').addEventListener('click', async () => {
    const blob = await canvasToBlob(canvas);
    const file = new File([blob], fileName, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: `QR label ${ext.code}` }); } catch { /* cancelled */ }
    } else {
      downloadBlob(blob, fileName);
      toast('Sharing is not supported here, so the label was downloaded');
    }
  });
  $('#dlBtn').addEventListener('click', async () => downloadBlob(await canvasToBlob(canvas), fileName));
  $('#printBtn').addEventListener('click', () => window.print());
}

/* ---------------- export / backup ---------------- */

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** Offer the native share sheet (email, chat, drive…) when available, else download. */
async function shareOrDownload(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    const choice = await sheet(title, [['share', 'Share (email, messages, drive…)'], ['download', 'Download to this device']]);
    if (choice === 'share') {
      try { await navigator.share({ files: [file], title }); } catch { /* cancelled */ }
      return;
    }
    if (choice !== 'download') return;
  }
  downloadBlob(blob, name);
  toast(`Saved ${name}`);
}

function sheet(title, options) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3>
      ${options.map(([k, l]) => `<button class="btn ${k === options[0][0] ? 'primary' : 'ghost'} block" data-k="${k}">${esc(l)}</button>`).join('')}
      <button class="btn link block" data-k="">Cancel</button></div>`;
    const done = (k) => { wrap.remove(); resolve(k); };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) done('');
      const b = e.target.closest('[data-k]');
      if (b) done(b.dataset.k);
    });
    document.body.appendChild(wrap);
    $('button', wrap).focus();
  });
}

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets from treating text as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCsv() {
  const [exts, surveys] = await Promise.all([DB.allExt(), DB.allSurveys()]);
  if (!surveys.length) { toast('There are no surveys to export yet'); return; }
  const byCode = Object.fromEntries(exts.map((e) => [e.code, e]));
  surveys.sort((a, b) => b.date.localeCompare(a.date));
  const header = ['Date', 'Time', 'ID No', 'App code', 'Name', 'Unit', 'Location', 'Type', 'Size', 'Result', 'Problems', 'Other problem', 'Notes', 'Operator'];
  const rows = surveys.map((s) => {
    const e = byCode[s.code] || {};
    const d = new Date(s.date);
    return [localDate(d), localTime(d), e.tag || s.code, s.code, e.name, e.unit, e.location, e.type, e.capacity,
      s.result === 'OK' ? 'OK' : 'NOT OK',
      (s.issues || []).map((k) => ISSUE_LABEL[k] || k).join('; '),
      s.otherNote, s.notes, s.operator];
  });
  const csv = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  await shareOrDownload(blob, `extinguisher_surveys_${localDate(new Date())}.csv`, 'Export surveys (CSV)');
}

async function backup() {
  const [extinguishers, surveys] = await Promise.all([DB.allExt(), DB.allSurveys()]);
  const data = { app: 'fe-survey', version: 1, exportedAt: new Date().toISOString(), extinguishers, surveys };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  await shareOrDownload(blob, `fe-survey-backup_${localDate(new Date())}.json`, 'Back up all data');
}

async function restore(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'fe-survey' || !Array.isArray(data.extinguishers) || !Array.isArray(data.surveys)) throw new Error('Not a backup from this app');
    const exts = data.extinguishers.filter((e) => e && e.code && (e.name || e.location)).map((e) => ({ ...e, code: normCode(e.code) }));
    const surveys = data.surveys.filter((s) => s && s.id && s.code && s.date && s.result).map((s) => ({ ...s, code: normCode(s.code) }));
    if (!confirm(`Merge ${exts.length} extinguishers and ${surveys.length} surveys into this device? Matching records will be overwritten.`)) return;
    await DB.importAll(exts, surveys);
    toast('Backup restored');
    router();
  } catch (err) {
    alert(`Could not restore: ${err.message}`);
  }
}

/* ---------------- menu ---------------- */

function closeMenu() { $('#menu').hidden = true; }

function initMenu() {
  const menu = $('#menu');
  $('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu(); });
  menu.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    closeMenu();
    if (action === 'export-csv') exportCsv();
    if (action === 'backup') backup();
    if (action === 'restore') $('#restoreInput').click();
    if (action === 'operator') {
      const name = prompt('Operator name', storageGet(OPERATOR_KEY));
      if (name != null) { storageSet(OPERATOR_KEY, name.trim()); toast('Operator name saved'); }
    }
  });
  $('#restoreInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) restore(f);
  });
}

/* ---------------- start ---------------- */

/**
 * Load the plant's extinguisher register (data/extinguishers.json) into this device's database.
 * Runs once per register version. It only adds extinguishers that are missing, so it never
 * overwrites edits made in the app or touches survey history.
 */
async function seedRegister() {
  try {
    const res = await fetch('data/extinguishers.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.version || storageGet(SEED_KEY) === data.version) return;
    const byCode = new Map((await DB.allExt()).map((e) => [e.code, e]));
    const now = new Date().toISOString();
    const put = [];
    for (const e of data.extinguishers) {
      const cur = byCode.get(e.code);
      if (!cur) put.push({ ...e, createdAt: now });
      else if (!cur.labelKey || cur.order == null) {
        put.push({ ...cur, tag: cur.tag || e.tag, unit: cur.unit || e.unit, labelKey: cur.labelKey || e.labelKey, order: e.order });
      }
    }
    if (put.length) await DB.importAll(put, []);
    storageSet(SEED_KEY, data.version);
  } catch (err) {
    console.warn('Could not load the extinguisher register', err);
  }
}

initMenu();
window.addEventListener('hashchange', router);
seedRegister().finally(router);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker failed', err));
}
