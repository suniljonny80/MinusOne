// MinusOne app: instrument picker, stem server, song library (IndexedDB) and the mixer.
import { Engine } from './engine.js';

const $ = (s, el = document) => el.querySelector(s);
const CFG = window.MINUSONE_CONFIG || {};

// ------------------------------------------------------------------ instruments
const PARTS = {
  vocals: { label: 'Vocals', phrase: 'sing', name: 'vocals', the: 'the vocals' },
  drums:  { label: 'Drums',  phrase: 'play the drums', name: 'drums', the: 'the drums' },
  bass:   { label: 'Bass',   phrase: 'play bass', name: 'bass', the: 'the bass' },
  guitar: { label: 'Guitar', phrase: 'play guitar', name: 'guitar', the: 'the guitar' },
  keys:   { label: 'Keys',   phrase: 'play keys', name: 'keys', the: 'the keys' },
};
const LABELS = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', guitar: 'Guitar', keys: 'Keys', other: 'Other' };

const store = {
  get(k, d) { try { const v = localStorage.getItem('m1.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('m1.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let you = PARTS[store.get('you')] ? store.get('you') : 'drums';

function setYou(part, save = true) {
  you = part;
  document.body.dataset.you = part;
  const words = PARTS[part].phrase.split(' ');
  const last = words.pop();
  $('#partButton').innerHTML = (words.length ? `<span class="ph">${words.join(' ')}</span> ` : '') +
    `<span class="nw"><span class="ph">${last}</span><span class="hero-dot">.</span>` +
    '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l7 7 7-7"/></svg></span>';
  $('#partButton').setAttribute('aria-label', `I ${PARTS[part].phrase}. Change instrument`);
  $('#lede').innerHTML = `Paste a YouTube link or drop in a song. MinusOne splits it into vocals, drums, bass, guitar and keys, then takes out <strong>${PARTS[part].the}</strong> so you can ${part === 'vocals' ? 'sing' : 'play'} along.`;
  document.querySelectorAll('.you-name').forEach((el) => { el.textContent = PARTS[part].name; });
  renderPartMenu();
  if (save) store.set('you', part);
  if (song) { applyMode(song.mode); buildConsole(); }
}

function renderPartMenu() {
  const menu = $('#partMenu');
  menu.innerHTML = '';
  Object.entries(PARTS).forEach(([key, p]) => {
    const li = document.createElement('li');
    li.role = 'option';
    li.id = 'opt-' + key;
    li.dataset.part = key;
    li.setAttribute('aria-selected', String(key === you));
    li.innerHTML = `<span class="sw" style="background:var(--${key})"></span>I ${p.phrase}`;
    menu.appendChild(li);
  });
}

function setupPicker() {
  const btn = $('#partButton'), menu = $('#partMenu');
  let active = 0;
  const keys = Object.keys(PARTS);
  const open = () => {
    menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
    active = keys.indexOf(you); highlight(); menu.focus?.();
  };
  const close = (focus = true) => {
    menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
    if (focus) btn.focus();
  };
  const highlight = () => {
    [...menu.children].forEach((li, i) => li.classList.toggle('active', i === active));
    btn.setAttribute('aria-activedescendant', 'opt-' + keys[active]);
  };
  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (menu.hidden && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); return; }
    if (menu.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % keys.length; highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active + keys.length - 1) % keys.length; highlight(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setYou(keys[active]); close(); }
    else if (e.key === 'Escape') { close(); }
  });
  menu.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li) { setYou(li.dataset.part); close(); }
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('.picker')) close(false);
  });
}

// ------------------------------------------------------------------ server
const server = {
  url: '', key: '', state: 'unset', info: null,
  load() {
    // The PC launcher opens the site as ?server=<tunnel address>; remember it and tidy the URL.
    const q = new URLSearchParams(location.search);
    const fromLink = (q.get('server') || '').trim();
    if (/^https?:\/\//.test(fromLink)) {
      store.set('server', fromLink.replace(/\/+$/, ''));
      q.delete('server');
      const rest = q.toString();
      history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    }
    this.url = (store.get('server', '') || CFG.server || '').trim().replace(/\/+$/, '');
    this.key = store.get('key', '') || '';
  },
  headers(extra = {}) { return this.key ? { 'X-Access-Key': this.key, ...extra } : extra; },
  async call(path, opts = {}) {
    if (!this.url) throw new Error('Not connected to a MinusOne server yet. Start the server on your PC; it opens this page already connected.');
    let res;
    try {
      res = await fetch(this.url + path, { ...opts, headers: this.headers(opts.headers) });
    } catch {
      throw new Error("Couldn't reach the MinusOne server. Check that the server window is open on your PC. If you restarted it, open the new link or scan the new QR code it shows.");
    }
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    if (!res.ok) {
      const msg = body?.error || body?.detail || (res.status === 503 ? 'The stem server is starting up. Try again in a minute.' : `Server error ${res.status}.`);
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      err.status = res.status;
      throw err;
    }
    return body;
  },
};

async function checkServer(quiet) {
  const pill = $('#serverPill'), text = $('#serverText');
  if (!server.url) { pill.dataset.state = 'unset'; text.textContent = 'Connect server'; server.state = 'unset'; return; }
  if (!quiet) { pill.dataset.state = 'waking'; text.textContent = 'Connecting'; }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch(server.url + '/api/health', { headers: server.headers(), signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(String(res.status));
    const info = await res.json();
    server.info = info;
    if (info.needs_key && !info.key_ok) {
      pill.dataset.state = 'down'; text.textContent = 'Needs access key'; server.state = 'key';
    } else {
      pill.dataset.state = 'ready'; server.state = 'ready';
      text.textContent = info.busy || info.queued ? `Server busy, ${info.queued + info.busy} in line` : 'Server ready';
    }
  } catch {
    pill.dataset.state = 'down'; text.textContent = 'Server offline'; server.state = 'down';
    setTimeout(() => checkServer(true), 10000);
  }
}

function setupSettings() {
  const dlg = $('#settings');
  const status = $('#settingsStatus');
  $('#serverPill').addEventListener('click', () => {
    $('#serverUrl').value = server.url;
    $('#serverKey').value = server.key;
    status.textContent = '';
    dlg.showModal();
  });
  $('#testServer').addEventListener('click', async () => {
    const url = $('#serverUrl').value.trim().replace(/\/+$/, '');
    if (!url) { status.textContent = 'Enter the server address first.'; return; }
    status.textContent = 'Testing…';
    try {
      const key = $('#serverKey').value.trim();
      const res = await fetch(url + '/api/health', { headers: key ? { 'X-Access-Key': key } : {} });
      const info = await res.json();
      if (info.needs_key && !info.key_ok) status.textContent = 'Connected, but the access key is missing or wrong.';
      else status.textContent = `Connected. It splits songs into ${info.stems.join(', ')} (up to ${info.max_minutes} minutes).`;
    } catch {
      status.textContent = "Couldn't connect. Check that the server window is open on your PC and the address matches the one it shows.";
    }
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    store.set('server', $('#serverUrl').value.trim().replace(/\/+$/, ''));
    store.set('key', $('#serverKey').value.trim());
    server.load();
    checkServer();
  });
}

// ------------------------------------------------------------------ library (IndexedDB)
const db = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('minusone', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('songs', { keyPath: 'id' });
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const t = d.transaction('songs', mode);
      const r = fn(t.objectStore('songs'));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
    });
  },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  get(id) { return this.tx('readonly', (s) => s.get(id)); },
  put(v) { return this.tx('readwrite', (s) => s.put(v)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
};

const thumbUrl = (s) => (s.youtube_id ? `https://i.ytimg.com/vi/${s.youtube_id}/mqdefault.jpg` : '');
const fmt = (t) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function renderLibrary() {
  let songs = [];
  try { songs = await db.all(); } catch { /* storage blocked */ }
  songs.sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
  const list = $('#songList');
  list.innerHTML = '';
  $('#libEmpty').hidden = songs.length > 0;
  for (const s of songs) {
    const li = document.createElement('li');
    const thumb = thumbUrl(s)
      ? `<img class="thumb" src="${thumbUrl(s)}" alt="" loading="lazy">`
      : `<span class="thumb tape">${esc((s.title || 'Song').slice(0, 28))}</span>`;
    li.innerHTML = `<a class="song-card" href="#/song/${encodeURIComponent(s.id)}">${thumb}
        <span><p class="t">${esc(s.title || 'Untitled song')}</p><p class="s">${s.artist ? esc(s.artist) + ', ' : ''}${fmt(s.duration)}</p></span></a>
      <button class="del" type="button" aria-label="Remove ${esc(s.title || 'song')} from this device" data-id="${esc(s.id)}">×</button>`;
    li.style.position = 'relative';
    list.appendChild(li);
  }
}

$('#songList').addEventListener('click', async (e) => {
  const del = e.target.closest('.del');
  if (!del) return;
  e.preventDefault();
  await db.del(del.dataset.id);
  toast('Removed from this device');
  renderLibrary();
});

// ------------------------------------------------------------------ splitting
let job = null;   // { id, cancelled }

function showError(msg) {
  const el = $('#formError');
  el.textContent = msg;
  el.hidden = !msg;
}

function jobUI({ title, note, step, pct, thumb }) {
  const box = $('#job');
  box.hidden = false;
  if (title != null) $('#jobTitle').textContent = title;
  if (note != null) $('#jobNote').textContent = note;
  if (thumb !== undefined) {
    const img = $('#jobThumb');
    img.hidden = !thumb;
    if (thumb) img.src = thumb;
  }
  if (step) {
    const order = ['fetch', 'split', 'load'];
    const at = order.indexOf(step);
    document.querySelectorAll('#steps li').forEach((li, i) => {
      li.classList.toggle('done', i < at);
      li.classList.toggle('on', i === at);
      li.querySelector('.step-state').textContent = i === at && pct != null ? `${Math.round(pct)}%` : '';
    });
    const overall = at * 33.3 + (pct || 0) * 0.333;
    $('#jobBar').style.width = `${Math.min(100, overall)}%`;
    $('.job .bar').setAttribute('aria-valuenow', String(Math.round(overall)));
  }
}

function endJob() {
  job = null;
  $('#job').hidden = true;
  $('#splitButton').disabled = false;
  $('#splitButton').textContent = 'Split song';
}

async function startJob(kind, payload) {
  showError('');
  if (job) return;
  if (!server.url) {
    showError('Not connected to a MinusOne server yet. Double-click "Start MinusOne Server" on your PC; it opens this page already connected. On a phone, scan the QR code it shows.');
    return;
  }
  job = { cancelled: false };
  $('#splitButton').disabled = true;
  $('#splitButton').textContent = 'Splitting…';
  jobUI({ title: kind === 'upload' ? payload.name : 'Contacting the server', note: '', step: 'fetch', pct: 0,
          thumb: kind === 'youtube' ? payload.thumb : null });
  try {
    let status;
    if (kind === 'youtube') {
      status = await server.call('/api/split', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: payload.url }),
      });
    } else {
      jobUI({ note: 'Uploading the file' });
      status = await uploadFile(payload);
    }
    job.id = status.id;
    status = await pollJob(status);
    if (job?.cancelled) return;
    const saved = await downloadStems(status);
    endJob();
    $('#urlInput').value = '';
    location.hash = '#/song/' + encodeURIComponent(saved.id);
  } catch (err) {
    if (!job?.cancelled) showError(err.message || String(err));
    endJob();
  }
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', server.url + '/api/upload');
    if (server.key) xhr.setRequestHeader('X-Access-Key', server.key);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) jobUI({ step: 'fetch', pct: (e.loaded / e.total) * 100 }); };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Couldn't upload the file. Check your connection and the server address."));
    xhr.send(fd);
  });
}

function describe(s) {
  if (s.status === 'queued') return { step: 'fetch', pct: 0, note: s.queue_position > 1 ? `Waiting for ${s.queue_position - 1} song${s.queue_position > 2 ? 's' : ''} ahead of yours` : 'Starting' };
  if (s.status === 'downloading') return { step: 'fetch', pct: s.progress, note: 'Downloading the audio from YouTube' };
  if (s.status === 'preparing') return { step: 'split', pct: 0, note: 'Preparing the audio' };
  if (s.status === 'separating') {
    const mins = s.duration ? Math.max(1, Math.round((s.duration * 1.2) / 60)) : null;
    return { step: 'split', pct: s.progress, note: 'Splitting into instruments. This takes about a minute on a fast PC, longer on an older one.' };
  }
  if (s.status === 'saving') return { step: 'split', pct: 100, note: 'Saving the stems' };
  return { step: 'load', pct: 0, note: '' };
}

async function pollJob(s) {
  let fails = 0;
  while (!job?.cancelled) {
    if (s.status === 'done') return s;
    if (s.status === 'error') throw new Error(s.error || 'The server could not split this song.');
    const d = describe(s);
    jobUI({ title: s.title || $('#jobTitle').textContent, ...d });
    await new Promise((r) => setTimeout(r, 2000));
    try {
      s = await server.call('/api/jobs/' + encodeURIComponent(job.id));
      fails = 0;
    } catch (err) {
      if (err.status === 404) throw err;
      if (++fails > 30) throw new Error('Lost contact with the MinusOne server. Check the server window on your PC; finished songs are kept there.');
      jobUI({ note: 'Lost contact with the server, retrying…' });
    }
  }
  return s;
}

async function downloadStems(s) {
  jobUI({ title: s.title, step: 'load', pct: 0, note: 'Downloading the stems to this device' });
  const stems = [];
  for (let i = 0; i < s.stems.length; i++) {
    const st = s.stems[i];
    const res = await fetch(server.url + st.url, { headers: server.headers() });
    if (!res.ok) throw new Error(`Couldn't download the ${st.name} stem (${res.status}).`);
    stems.push({ name: st.name, blob: await res.blob() });
    jobUI({ step: 'load', pct: ((i + 1) / s.stems.length) * 100 });
  }
  const rec = { id: s.id, title: s.title || 'Untitled song', artist: s.artist || '', duration: s.duration,
                youtube_id: s.youtube_id || null, source: s.source, stems, added: Date.now(), opened: Date.now() };
  try { await db.put(rec); } catch { toast("This browser won't let MinusOne save songs, so it will only last this session."); }
  memoryCache.set(rec.id, rec);
  return rec;
}
const memoryCache = new Map();

function setupSplitForm() {
  const input = $('#urlInput');
  $('#splitForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) { showError('Paste a YouTube link first, or upload a file.'); input.focus(); return; }
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
    if (!m) { showError("That doesn't look like a YouTube link. It should look like https://www.youtube.com/watch?v=… or https://youtu.be/…"); return; }
    startJob('youtube', { url, thumb: `https://i.ytimg.com/vi/${m[1]}/mqdefault.jpg` });
  });
  input.addEventListener('input', () => showError(''));
  $('#uploadButton').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) startJob('upload', f);
    e.target.value = '';
  });
  $('#jobCancel').addEventListener('click', () => {
    if (job) job.cancelled = true;
    endJob();
    toast('Stopped waiting. The server keeps working; split the same song again to pick it up.');
  });

  // drag and drop anywhere on the home page
  const drop = $('#drop');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (route.name !== 'home' || !e.dataTransfer?.types?.includes('Files')) return;
    depth++; drop.hidden = false;
  });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; drop.hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f && route.name === 'home') startJob('upload', f);
  });
}

// ------------------------------------------------------------------ mixer
const engine = new Engine();
let song = null;   // { rec, ch: [{name, vol, mute, solo}], mode, tempo, pitch, loop }

const posToGain = (p) => (p <= 0 ? 0 : Math.pow(p / 0.75, 2));
const gainToDb = (g) => (g <= 0.0001 ? '−∞' : `${(20 * Math.log10(g)) >= 0 ? '+' : '−'}${Math.abs(20 * Math.log10(g)).toFixed(1)}`);

function effectiveGains() {
  const anySolo = song.ch.some((c) => c.solo);
  return song.ch.map((c) => ((anySolo ? c.solo : !c.mute) ? posToGain(c.vol) : 0));
}

function currentMode() {
  const yi = song.ch.findIndex((c) => c.name === you);
  if (yi < 0) return 'full';
  const anySolo = song.ch.some((c) => c.solo);
  if (anySolo) return song.ch.every((c, i) => c.solo === (i === yi)) ? 'only' : 'custom';
  const muted = song.ch.filter((c) => c.mute).map((c) => c.name);
  if (muted.length === 0) return 'full';
  if (muted.length === 1 && muted[0] === you) return 'without';
  return 'custom';
}

function applyMode(mode) {
  song.ch.forEach((c) => {
    c.solo = mode === 'only' && c.name === you;
    c.mute = mode === 'without' && c.name === you;
  });
  song.mode = mode;
  pushGains();
}

function pushGains() {
  engine.setGains(effectiveGains());
  const mode = currentMode();
  song.mode = mode;
  document.querySelectorAll('#modes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  document.querySelectorAll('.strip[data-index]').forEach((el) => {
    const i = +el.dataset.index, c = song.ch[i];
    const g = effectiveGains()[i];
    el.classList.toggle('silent', g === 0);
    el.querySelector('.m').setAttribute('aria-pressed', String(c.mute));
    el.querySelector('.s').setAttribute('aria-pressed', String(c.solo));
  });
  drawWave();
  saveMix();
}

function saveMix() {
  if (!song) return;
  const mixes = store.get('mixes', {});
  mixes[song.rec.id] = { vol: song.ch.map((c) => c.vol), master: song.master };
  const keys = Object.keys(mixes);
  if (keys.length > 60) delete mixes[keys[0]];
  store.set('mixes', mixes);
}

function fader(el, value, onChange, label) {
  el.className = 'fader';
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
  el.innerHTML = '<span class="slot"></span><span class="zero"></span><span class="fill"></span><span class="cap"></span>';
  const set = (v, emit = true) => {
    v = Math.max(0, Math.min(1, v));
    el.style.setProperty('--pos', v.toFixed(4));
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    el.setAttribute('aria-valuetext', gainToDb(posToGain(v)) + ' dB');
    if (emit) onChange(v);
    value = v;
  };
  const fromPointer = (e) => {
    const r = el.getBoundingClientRect();
    const vertical = r.height > r.width;
    return vertical ? 1 - (e.clientY - r.top - 10) / (r.height - 20) : (e.clientX - r.left - 10) / (r.width - 20);
  };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    set(fromPointer(e));
    const move = (ev) => set(fromPointer(ev));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  el.addEventListener('dblclick', () => set(0.75));
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.025;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); set(value + step); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); set(value - step); }
    else if (e.key === 'Home') { e.preventDefault(); set(0); }
    else if (e.key === 'End') { e.preventDefault(); set(1); }
  });
  set(value, false);
  return set;
}

function buildConsole() {
  const con = $('#console');
  con.innerHTML = '';
  song.ch.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'strip';
    el.dataset.name = c.name;
    el.dataset.index = i;
    const label = LABELS[c.name] || c.name;
    el.innerHTML = `
      <div class="label"><div class="tape">${label}</div>${c.name === you ? '<span class="you-tag">you</span>' : ''}</div>
      <div class="fader-zone"><div class="meter" aria-hidden="true"></div><div class="fdr"></div></div>
      <div class="db" aria-hidden="true"></div>
      <div class="ms">
        <button class="m" type="button" aria-pressed="false" aria-label="Mute ${label}" title="Mute (${i + 1})">M</button>
        <button class="s" type="button" aria-pressed="false" aria-label="Solo ${label}" title="Solo (Shift+${i + 1})">S</button>
      </div>`;
    con.appendChild(el);
    const db = el.querySelector('.db');
    fader(el.querySelector('.fdr'), c.vol, (v) => {
      c.vol = v; db.textContent = gainToDb(posToGain(v)); pushGains();
    }, `${label} volume`);
    db.textContent = gainToDb(posToGain(c.vol));
    el.querySelector('.m').addEventListener('click', () => toggleMute(i));
    el.querySelector('.s').addEventListener('click', () => toggleSolo(i));
  });
  // master
  const m = document.createElement('div');
  m.className = 'strip master';
  m.innerHTML = `<div class="label"><div class="tape">Master</div></div>
    <div class="fader-zone"><div class="meter" aria-hidden="true"></div><div class="fdr"></div></div>
    <div class="db" aria-hidden="true"></div><div class="ms"><button class="m" tabindex="-1" aria-hidden="true">M</button></div>`;
  con.appendChild(m);
  const mdb = m.querySelector('.db');
  fader(m.querySelector('.fdr'), song.master, (v) => {
    song.master = v; mdb.textContent = gainToDb(posToGain(v)); engine.setMaster(posToGain(v)); saveMix();
  }, 'Master volume');
  mdb.textContent = gainToDb(posToGain(song.master));
  pushGains();
}

function toggleMute(i) { const c = song.ch[i]; c.mute = !c.mute; if (c.mute) c.solo = false; pushGains(); }
function toggleSolo(i) { const c = song.ch[i]; c.solo = !c.solo; if (c.solo) c.mute = false; pushGains(); }

// ---- waveform overview
const wave = $('#wave');
function drawWave() {
  if (!song || !engine.peaks.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wave.clientWidth, h = wave.clientHeight;
  if (!w) return;
  if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr); }
  const g = wave.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const gains = effectiveGains();
  const css = getComputedStyle(document.body);
  const colors = song.ch.map((c) => css.getPropertyValue('--' + c.name).trim() || '#9aa8b1');
  const bins = engine.peaks[0].length;
  const cols = Math.max(60, Math.floor(w / 3));
  const per = bins / cols;
  // total of all stems for the ghost outline, and normaliser
  let maxSum = 0;
  const sums = new Float32Array(cols);
  for (let x = 0; x < cols; x++) {
    let tot = 0;
    for (let s = 0; s < engine.peaks.length; s++) {
      let m = 0;
      for (let b = Math.floor(x * per); b < Math.floor((x + 1) * per); b++) m = Math.max(m, engine.peaks[s][b] || 0);
      tot += m;
    }
    sums[x] = tot; maxSum = Math.max(maxSum, tot);
  }
  const mid = h / 2, scale = (h / 2 - 4) / (maxSum || 1);
  const playedX = (engine.time / (engine.duration || 1)) * w;
  const bw = w / cols;
  for (let x = 0; x < cols; x++) {
    const px = x * bw;
    const played = px < playedX;
    // ghost of everything (shows what is muted)
    g.fillStyle = 'rgba(141,152,159,0.16)';
    const gh = sums[x] * scale;
    g.fillRect(px, mid - gh, Math.max(1, bw - 1), gh * 2);
    // audible stems stacked from the centre outward
    let up = 0;
    for (let s = 0; s < engine.peaks.length; s++) {
      if (!gains[s]) continue;
      let m = 0;
      for (let b = Math.floor(x * per); b < Math.floor((x + 1) * per); b++) m = Math.max(m, engine.peaks[s][b] || 0);
      const hh = m * scale * Math.min(1.4, Math.sqrt(gains[s]));
      g.globalAlpha = played ? 1 : 0.55;
      g.fillStyle = colors[s];
      g.fillRect(px, mid - up - hh, Math.max(1, bw - 1), hh);
      g.fillRect(px, mid + up, Math.max(1, bw - 1), hh);
      up += hh;
    }
    g.globalAlpha = 1;
  }
}

function updatePlayhead() {
  if (!song) return;
  const w = $('#overview').clientWidth;
  const x = (engine.time / (engine.duration || 1)) * w;
  $('#playhead').style.transform = `translateX(${x - 1}px)`;
  $('#timeNow').textContent = fmt(engine.time);
}

function renderLoop() {
  if (!song) return;
  const band = $('#loopBand'), L = song.loop;
  const has = L.b > L.a + 0.05;
  $('#loopClear').hidden = !has;
  $('#loopButton').setAttribute('aria-pressed', String(L.on && has));
  $('#loopRange').textContent = has ? `${fmt(L.a)} to ${fmt(L.b)}` : 'Drag over the waveform';
  if (!has) { band.hidden = true; return; }
  const w = $('#overview').clientWidth, d = engine.duration || 1;
  band.hidden = false;
  band.style.left = `${(L.a / d) * w}px`;
  band.style.width = `${((L.b - L.a) / d) * w}px`;
  band.style.opacity = L.on ? 1 : 0.4;
}

function setLoop(a, b, on) {
  song.loop = { a: Math.max(0, Math.min(a, b)), b: Math.min(engine.duration, Math.max(a, b)), on };
  engine.setLoop(on && song.loop.b > song.loop.a + 0.05, song.loop.a, song.loop.b);
  renderLoop();
}

function setupOverview() {
  const ov = $('#overview');
  let start = null;
  const timeAt = (e) => {
    const r = ov.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * engine.duration;
  };
  ov.addEventListener('pointerdown', (e) => {
    ov.setPointerCapture(e.pointerId);
    start = { x: e.clientX, t: timeAt(e), dragging: false };
  });
  ov.addEventListener('pointermove', (e) => {
    if (!start) return;
    if (!start.dragging && Math.abs(e.clientX - start.x) > 6) start.dragging = true;
    if (start.dragging) {
      song.loop = { a: Math.min(start.t, timeAt(e)), b: Math.max(start.t, timeAt(e)), on: true };
      renderLoop();
    }
  });
  const end = (e) => {
    if (!start) return;
    if (start.dragging) {
      setLoop(song.loop.a, song.loop.b, true);
      engine.seek(song.loop.a);
    } else {
      engine.seek(timeAt(e));
    }
    start = null;
    updatePlayhead(); drawWave();
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', () => { start = null; });

  $('#loopButton').addEventListener('click', () => {
    const L = song.loop;
    if (L.b > L.a + 0.05) { setLoop(L.a, L.b, !L.on); if (song.loop.on) engine.seek(L.a); }
    else {   // no region yet: loop the next 8 seconds from here
      const a = engine.time, b = Math.min(engine.duration, a + 8);
      setLoop(a, b, true);
    }
  });
  $('#loopClear').addEventListener('click', () => setLoop(0, 0, false));
  window.addEventListener('resize', () => { drawWave(); renderLoop(); updatePlayhead(); });
}

// ---- speed & key
const SPEEDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25];
function setTempo(v) {
  song.tempo = v; engine.setTempo(v);
  $('#speedVal').textContent = `${Math.round(v * 100)}%`;
  $('#speedVal').classList.toggle('changed', v !== 1);
}
function setPitch(v) {
  song.pitch = Math.max(-6, Math.min(6, v)); engine.setPitch(song.pitch);
  $('#keyVal').textContent = song.pitch > 0 ? `+${song.pitch}` : String(song.pitch).replace('-', '−');
  $('#keyVal').classList.toggle('changed', song.pitch !== 0);
}
function setupTools() {
  $('#slower').addEventListener('click', () => setTempo(SPEEDS[Math.max(0, SPEEDS.indexOf(song.tempo) - 1)]));
  $('#faster').addEventListener('click', () => setTempo(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(song.tempo) + 1)]));
  $('#speedVal').addEventListener('click', () => setTempo(1));
  $('#keyDown').addEventListener('click', () => setPitch(song.pitch - 1));
  $('#keyUp').addEventListener('click', () => setPitch(song.pitch + 1));
  $('#keyVal').addEventListener('click', () => setPitch(0));
  $('#playButton').addEventListener('click', () => togglePlay());
  $('#backButton').addEventListener('click', () => engine.seek(engine.time - 5));
  $('#modes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) applyMode(b.dataset.mode);
  });
  $('#exportButton').addEventListener('click', exportMix);
}

async function togglePlay() {
  if (engine.playing) engine.pause(); else await engine.play();
  syncPlayButton();
}
function syncPlayButton() {
  const b = $('#playButton');
  b.classList.toggle('on', engine.playing);
  b.setAttribute('aria-label', engine.playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = engine.playing ? 'playing' : 'paused';
}

engine.addEventListener('time', () => { updatePlayhead(); meters(); syncPlayButton(); });
engine.addEventListener('ended', () => { syncPlayButton(); engine.seek(0); });
let waveTick = 0;
setInterval(() => { if (song && engine.playing && ++waveTick % 2 === 0) drawWave(); }, 500);

function meters() {
  if (!song) return;
  const strips = document.querySelectorAll('#console .strip');
  if (!strips.length) return;
  let total = 0;
  engine.levels.forEach((p, i) => {
    total += p;
    const el = strips[i]?.querySelector('.meter');
    if (el) el.style.setProperty('--lvl', levelToMeter(p).toFixed(3));
  });
  const master = strips[strips.length - 1]?.querySelector('.meter');
  if (master) master.style.setProperty('--lvl', levelToMeter(Math.min(1.2, total * posToGain(song.master))).toFixed(3));
}
const levelToMeter = (p) => (p <= 0.0004 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(p) + 48) / 48)));

async function exportMix() {
  const gains = effectiveGains();
  if (!gains.some((g) => g > 0)) { toast('Everything is muted, so there is nothing to download.'); return; }
  const btn = $('#exportButton');
  btn.disabled = true;
  const label = btn.textContent;
  const L = song.loop;
  const useLoop = L.on && L.b > L.a + 0.05;
  try {
    const blob = await engine.renderMix({
      gains, master: posToGain(song.master), tempo: song.tempo, pitch: song.pitch,
      from: useLoop ? L.a : 0, to: useLoop ? L.b : null,
    }, (p) => { btn.textContent = `Preparing ${Math.round(p * 100)}%`; });
    const mode = currentMode();
    const what = mode === 'without' ? ` (no ${you})` : mode === 'only' ? ` (${you} only)` : mode === 'custom' ? ' (custom mix)' : '';
    const extra = [song.tempo !== 1 ? `${Math.round(song.tempo * 100)}%` : '', song.pitch ? `key ${song.pitch > 0 ? '+' : ''}${song.pitch}` : ''].filter(Boolean).join(' ');
    const name = `${song.rec.title}${what}${extra ? ' ' + extra : ''}${useLoop ? ' loop' : ''}.wav`.replace(/[\\/:*?"<>|]+/g, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast('Mix downloaded');
  } catch (err) {
    toast("Couldn't prepare the download: " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

async function openSong(id) {
  let rec = memoryCache.get(id);
  if (!rec) { try { rec = await db.get(id); } catch { /* */ } }
  if (!rec) { toast('That song is no longer on this device.'); location.hash = '#/'; return; }
  const mixes = store.get('mixes', {})[id];
  engine.pause();
  song = {
    rec,
    ch: rec.stems.map((s, i) => ({ name: s.name, vol: mixes?.vol?.[i] ?? 0.75, mute: false, solo: false })),
    master: mixes?.master ?? 0.75, mode: 'without', tempo: 1, pitch: 0, loop: { a: 0, b: 0, on: false },
  };
  song.ch.forEach((c) => { c.mute = c.name === you; });
  $('#songTitle').textContent = rec.title;
  $('#songSub').textContent = rec.artist || (rec.source === 'upload' ? 'Uploaded file' : 'From YouTube');
  const th = $('#songThumb');
  th.hidden = !rec.youtube_id;
  if (rec.youtube_id) th.src = thumbUrl(rec);
  document.title = `${rec.title}: MinusOne`;
  showView('song');
  buildConsole();
  setTempo(1); setPitch(0);

  const overlay = $('#loading');
  overlay.hidden = false;
  try {
    await engine.load(rec.stems, effectiveGains(), (p, name) => {
      $('#loadingText').textContent = p < 1 ? `Loading ${LABELS[name] || name}` : 'Ready';
      $('#loadingBar').style.width = `${p * 100}%`;
    });
  } catch (err) {
    overlay.hidden = true;
    toast("This browser couldn't open the song: " + err.message);
    return;
  }
  overlay.hidden = true;
  engine.setMaster(posToGain(song.master));
  engine.setLoop(false, 0, 0);
  $('#timeTotal').textContent = fmt(engine.duration);
  setLoop(0, 0, false);
  drawWave(); updatePlayhead();
  rec.opened = Date.now();
  db.put(rec).catch(() => {});
  setupMediaSession(rec);
}

function setupMediaSession(rec) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: rec.title, artist: currentMode() === 'without' ? `MinusOne, without ${you}` : 'MinusOne practice mix',
    artwork: rec.youtube_id ? [{ src: thumbUrl(rec), sizes: '320x180', type: 'image/jpeg' }] : [],
  });
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* */ } };
  h('play', () => togglePlay());
  h('pause', () => togglePlay());
  h('seekbackward', () => engine.seek(engine.time - 5));
  h('seekforward', () => engine.seek(engine.time + 5));
}

// keyboard shortcuts on the mixer
document.addEventListener('keydown', (e) => {
  if (route.name !== 'song' || !song) return;
  if (e.target.closest('input, textarea, dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') {
    if (e.target.closest('button, [role="slider"]') && e.target !== document.body) {
      if (!e.target.closest('.overview')) return;
    }
    e.preventDefault(); togglePlay();
  } else if (e.key === 'ArrowLeft' && !e.target.closest('[role="slider"]')) { e.preventDefault(); engine.seek(engine.time - 5); }
  else if (e.key === 'ArrowRight' && !e.target.closest('[role="slider"]')) { e.preventDefault(); engine.seek(engine.time + 5); }
  else if (e.key.toLowerCase() === 'l') { $('#loopButton').click(); }
  else if (/^Digit[1-9]$/.test(e.code)) {
    const i = +e.code.slice(5) - 1;
    if (i < song.ch.length) { e.preventDefault(); e.shiftKey ? toggleSolo(i) : toggleMute(i); }
  }
});

// ------------------------------------------------------------------ routing
const route = { name: 'home' };
function showView(name) {
  route.name = name;
  $('#home').hidden = name !== 'home';
  $('#song').hidden = name !== 'song';
  window.scrollTo(0, 0);
}
function onRoute() {
  const m = location.hash.match(/^#\/song\/(.+)$/);
  if (m) { openSong(decodeURIComponent(m[1])); return; }
  engine.pause(); syncPlayButton();
  song = null;
  document.title = 'MinusOne: play along without your part';
  showView('home');
  renderLibrary();
}

// ------------------------------------------------------------------ misc
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

// shared link support: ?v=<youtube id> or ?url=<link> fills the box
function prefillFromQuery() {
  const q = new URLSearchParams(location.search);
  const v = q.get('url') || (q.get('v') ? `https://www.youtube.com/watch?v=${q.get('v')}` : '');
  if (v) $('#urlInput').value = v;
}

// ------------------------------------------------------------------ start
server.load();
if (CFG.repo) $('#repoLink').href = CFG.repo;
setYou(you, false);
setupPicker();
setupSettings();
setupSplitForm();
setupOverview();
setupTools();
prefillFromQuery();
window.addEventListener('hashchange', onRoute);
onRoute();
checkServer();
window.minusone = { engine, server, db, get song() { return song; } };   // handy for debugging
