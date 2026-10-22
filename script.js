'use strict';
// Transcription runs locally in the browser with Whisper (Transformers.js from jsDelivr), or optionally via the Groq cloud API.
const TJS_VERSIONS = ['3.7.0', '3.5.2', '3.3.3'];
const MAX_SEC = 2 * 3600 + 5, SR = 16000;
const $ = id => document.getElementById(id);
const audio = $('audio');
let tabs = [], cur = null, lanes = 0, hitIdx = [], hitPos = -1, nowIdx = -1, wordEl = null;
const pending = [];
const cancelErr = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// ---------- saved data (IndexedDB): files and transcripts survive a page refresh ----------
const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((ok, no) => {
    const r = indexedDB.open('transcriber', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('meta', { keyPath: 'id' }); r.result.createObjectStore('blobs'); };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  }));
  const run = async (stores, mode, fn) => { const db = await open(); return new Promise((ok, no) => { const t = db.transaction(stores, mode), req = fn(t); t.oncomplete = () => ok(req && req.result); t.onerror = t.onabort = () => no(t.error); }); };
  return {
    putMeta: m => run('meta', 'readwrite', t => t.objectStore('meta').put(m)),
    putBlob: (id, b) => run('blobs', 'readwrite', t => t.objectStore('blobs').put(b, id)),
    allMeta: () => run('meta', 'readonly', t => t.objectStore('meta').getAll()),
    getBlob: id => run('blobs', 'readonly', t => t.objectStore('blobs').get(id)),
    del: id => run(['meta', 'blobs'], 'readwrite', t => { t.objectStore('meta').delete(id); t.objectStore('blobs').delete(id); t.objectStore('blobs').delete(id + ':play'); })
  };
})();
let warned = false;
function persist(t) {
  if (!t.id || t.dur <= 0) return;
  clearTimeout(t.saveTimer);
  t.saveTimer = setTimeout(async () => {
    try {
      if (!t.stored) { await idb.putBlob(t.id, t.file); t.stored = true; }
      await idb.putMeta({ id: t.id, added: t.added, name: t.file.name, mime: t.file.type, dur: t.dur, segs: t.segs, speakers: t.speakers });
    } catch (e) { if (!warned) { warned = true; say('Could not save to this browser (storage full or blocked). Your work will be lost if you refresh.', 'err'); } }
  }, 500);
}
const safe = n => n.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'transcript';

// ---------- helpers ----------
function say(text, kind) { const m = $('msg'); m.hidden = !text; m.textContent = text || ''; m.className = 'msg ' + (kind || ''); }
function fmt(s, ms) {
  s = Math.max(0, s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = Math.floor(s % 60);
  const p = n => String(n).padStart(2, '0'); const o = (h ? h + ':' + p(m) : m) + ':' + p(x);
  return ms ? p(h) + ':' + p(m) + ':' + p(x) + ',' + String(Math.round((s % 1) * 1000)).padStart(3, '0') : o;
}
function size(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB'; }
function enable(on) { ['back', 'play', 'stop', 'fwd', 'seek'].forEach(i => $(i).disabled = !on); }
function eta(p, t0) { const el = (Date.now() - t0) / 1000; return 'elapsed ' + fmt(el) + (p > 4 ? ', about ' + fmt(el * (100 - p) / p) + ' left' : ''); }

// ---------- theme ----------
(function () {
  let t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  try { t = localStorage.getItem('theme') || t; } catch (e) {}
  const apply = v => { document.documentElement.dataset.theme = v; $('themeBtn').textContent = v === 'dark' ? 'Light theme' : 'Dark theme'; try { localStorage.setItem('theme', v); } catch (e) {} };
  apply(t); $('themeBtn').onclick = () => apply(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
})();

// ---------- accent colour ----------
(function () {
  const root = document.documentElement; let cur = 'teal';
  try { cur = localStorage.getItem('accent') || cur; } catch (e) {}
  const rgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  function apply(v) {
    ['--acc', '--acc2', '--accInk'].forEach(p => root.style.removeProperty(p));
    if (v[0] === '#') {
      const c = rgb(v); root.dataset.accent = 'custom';
      root.style.setProperty('--acc', v); root.style.setProperty('--acc2', hex(c.map(x => x + (255 - x) * 0.3)));
      root.style.setProperty('--accInk', (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.6 ? '#0b0f14' : '#ffffff');
      $('customColor').value = v;
    } else root.dataset.accent = v;
    document.querySelectorAll('.sw[data-c]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.c === v)));
    try { localStorage.setItem('accent', v); } catch (e) {}
  }
  document.querySelectorAll('.sw[data-c]').forEach(b => b.onclick = () => apply(b.dataset.c));
  $('customColor').oninput = e => apply(e.target.value);
  apply(cur);
})();

// ---------- tabs (one per file, no limit) ----------
const drop = $('drop');
['dragover', 'dragenter'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', ev => addFiles(ev.dataTransfer.files));
drop.addEventListener('keydown', ev => { if (ev.key === 'Enter') $('file').click(); });
$('file').onchange = ev => { addFiles(ev.target.files); ev.target.value = ''; };

function label(t) { return { loading: '…', ready: 'ready', queued: 'queued', running: Math.round(t.pct) + '%', done: 'done', error: 'error' }[t.status]; }
function addFiles(list) { [...list].forEach(addFile); }
function addFile(f) {
  const t = { id: Date.now() + '-' + Math.random().toString(36).slice(2), added: Date.now(), file: f, url: URL.createObjectURL(f), dur: 0, segs: [], speakers: ['Speaker 1', 'Speaker 2'], status: 'loading', pct: 0, msg: '', workers: [] };
  tabs.push(t); if (!cur) select(t); else update();
  const p = new Audio(); p.preload = 'metadata';
  p.onloadedmetadata = () => {
    const d = p.duration;
    if (!isFinite(d) || d <= 0) { t.status = 'error'; t.msg = 'This file has no readable duration. Try MP3 or WAV.'; }
    else if (d > MAX_SEC) { t.status = 'error'; t.msg = 'This recording is ' + fmt(d) + ' long. The limit is 2:00:00 per file. Split it and add the parts.'; }
    else { t.dur = d; t.status = 'ready'; t.msg = ''; persist(t); if (d > 3600) say(f.name + ' is over 1 hour. Long files need a lot of memory; if the page runs out of memory, split the file into two parts.'); }
    update();
  };
  p.onerror = () => { t.status = 'error'; t.msg = 'This browser cannot play "' + f.name + '". The format is unsupported or the file is damaged. Try MP3 or WAV.'; update(); };
  p.src = t.url;
}
function select(t) { cur = t; try { localStorage.setItem('curTab', t ? t.id : ''); } catch (e) {} audio.pause(); if (t) audio.src = t.playUrl || t.url; else audio.removeAttribute('src'); nowIdx = -1; drawSpeakers(); render(); update(); }
function closeTab(t) {
  cancelTab(t); URL.revokeObjectURL(t.url); clearTimeout(t.saveTimer); idb.del(t.id).catch(() => {});
  const i = tabs.indexOf(t); tabs.splice(i, 1);
  if (cur === t) select(tabs[i] || tabs[i - 1] || null); else update();
}
function cancelTab(t) {
  t.cancelled = true; if (t.ctl) t.ctl.abort(); if (t.abortFn) t.abortFn();
  if (t.status === 'queued') { t.status = 'ready'; t.msg = ''; }
}
function paint(t) { if (t.badge) t.badge.textContent = label(t); if (t === cur) { $('prog').value = t.pct; $('progTxt').textContent = t.msg; } }
function update() {
  const bar = $('tabs'); bar.textContent = ''; bar.hidden = !tabs.length;
  tabs.forEach(t => {
    const b = document.createElement('div'); b.className = 'tab' + (t === cur ? ' on' : '');
    const l = document.createElement('button'); l.className = 'tl'; l.textContent = t.file.name; l.title = t.file.name; l.onclick = () => select(t);
    const s = document.createElement('span'); s.className = 'st ' + t.status; s.textContent = label(t); t.badge = s;
    const x = document.createElement('button'); x.className = 'tx'; x.textContent = '×'; x.title = 'Close this tab'; x.setAttribute('aria-label', 'Close ' + t.file.name); x.onclick = () => closeTab(t);
    b.append(l, s, x); bar.append(b);
  });
  const t = cur, busy = !!t && (t.status === 'running' || t.status === 'queued'), ok = !!t && t.dur > 0;
  $('info').hidden = !t;
  if (t) { $('iName').textContent = t.file.name; $('iDur').textContent = t.dur ? fmt(t.dur) : '…'; $('iSize').textContent = size(t.file.size); $('tot').textContent = fmt(t.dur); }
  enable(ok); $('goBtn').disabled = !ok || busy; $('cancelBtn').hidden = !busy;
  const n = tabs.filter(x => x.dur > 0 && (x.status === 'ready' || x.status === 'error')).length;
  $('goAll').disabled = !n; $('goAll').textContent = 'Transcribe all' + (n ? ' (' + n + ')' : '');
  const anyDone = tabs.some(x => x.status === 'done');
  $('saveAll').disabled = !anyDone; $('docAll').disabled = !anyDone;
  const has = !!t && t.segs.length > 0; ['copy', 'folder', 'txt', 'srt', 'csv', 'shiftBtn'].forEach(i => $(i).disabled = !has);
  const showP = !!t && (busy || t.status === 'error'); $('progWrap').hidden = !showP;
  if (showP) { $('prog').hidden = t.status === 'error'; paint(t); }
}

// ---------- player ----------
const D = () => cur ? cur.dur : 0;
$('play').onclick = () => audio.paused ? audio.play() : audio.pause();
audio.onplay = () => { $('play').textContent = 'Pause'; if (!raf) raf = requestAnimationFrame(loop); };
audio.onpause = () => $('play').textContent = 'Play';
$('stop').onclick = () => { audio.pause(); audio.currentTime = 0; };
$('back').onclick = () => audio.currentTime = Math.max(0, audio.currentTime - 5);
$('fwd').onclick = () => audio.currentTime = Math.min(D(), audio.currentTime + 5);
$('mute').onclick = () => { audio.muted = !audio.muted; $('mute').textContent = audio.muted ? 'Unmute' : 'Mute'; };
$('vol').oninput = e => audio.volume = +e.target.value;
$('speed').onchange = e => { audio.defaultPlaybackRate = audio.playbackRate = +e.target.value; };
$('seek').oninput = e => audio.currentTime = e.target.value / 1000 * D();
function sync() {
  if (!cur) return;
  $('cur').textContent = fmt(audio.currentTime);
  if (cur.dur) $('seek').value = audio.currentTime / cur.dur * 1000;
  const t = audio.currentTime, i = cur.segs.findIndex(s => t >= s.start && t < s.end);
  if (i !== nowIdx) {
    document.querySelector('.seg.now')?.classList.remove('now'); nowIdx = i;
    const el = i >= 0 && $('tr').children[i];
    if (el) { el.classList.add('now'); if ($('auto').checked) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  const sg = cur.segs[nowIdx], row = $('tr').children[nowIdx]; let wel = null;
  if (sg && sg.words && row) { const k = sg.words.findLastIndex(w => w[1] <= t); wel = k >= 0 ? row.lastChild.children[k] || null : null; }
  if (wel !== wordEl) { if (wordEl) wordEl.classList.remove('wnow'); if (wel) wel.classList.add('wnow'); wordEl = wel; }
}
audio.ontimeupdate = sync; audio.onseeked = sync;
let raf = 0;
const loop = () => { sync(); raf = audio.paused ? 0 : requestAnimationFrame(loop); };

// ---------- decoding ----------
async function decode(f) { // -> { mono } or, for a real two-sided stereo call, { chans: [left, right] }
  const AC = window.AudioContext || window.webkitAudioContext, ctx = new AC({ sampleRate: SR });
  try {
    const buf = await ctx.decodeAudioData(await f.arrayBuffer()), n = buf.length;
    if (buf.numberOfChannels === 2) {
      const L = buf.getChannelData(0), R = buf.getChannelData(1); let sd = 0, ss = 0;
      for (let i = 0; i < n; i += 4) { const d = L[i] - R[i], m = L[i] + R[i]; sd += d * d; ss += m * m; }
      if (ss > 0 && sd / ss > 0.2) return { chans: [L, R] }; // the two sides carry different voices
    }
    const out = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels; }
    return { mono: out };
  } catch (e) { throw new Error('The audio could not be decoded. The format may be unsupported or the file damaged. Try MP3 or WAV.'); }
  finally { ctx.close(); }
}
const mixdown = ch => { const o = new Float32Array(ch[0].length); ch.forEach(c => { for (let i = 0; i < o.length; i++) o[i] += c[i] / ch.length; }); return o; };

// Loudness envelope and quantile, shared by the silence/timing passes so the audio is scanned once instead of four times.
function rmsEnv(pcm, F) {
  const nf = Math.floor(pcm.length / F), r = new Float32Array(nf);
  for (let f = 0; f < nf; f++) { let s = 0; const o = f * F; for (let i = 0; i < F; i++) { const v = pcm[o + i]; s += v * v; } r[f] = Math.sqrt(s / F); }
  return r;
}
function pct(r, q) { // q-th quantile; on very long files it is read off a sample, which lands in the same place
  const n = r.length; if (!n) return 0;
  const step = Math.max(1, Math.ceil(n / 200000)), m = Math.floor((n + step - 1) / step), s = new Float32Array(m);
  for (let i = 0, j = 0; j < m; i += step, j++) s[j] = r[i];
  s.sort(); return s[Math.floor(m * q)] || 0;
}

/*GAP*/
// Completeness helpers: boost quiet speech, cut at silence, find speech that has no text.
function normalize(x) { // gentle automatic gain: quiet passages are boosted (max 10x), loud ones untouched
  const B = 8000, nb = Math.ceil(x.length / B), g = new Float32Array(nb + 1);
  for (let b = 0; b < nb; b++) { let s = 0; const e = Math.min(x.length, (b + 1) * B); for (let i = b * B; i < e; i++) s += x[i] * x[i]; const rms = Math.sqrt(s / (e - b * B)); g[b] = rms > 0.003 ? Math.min(10, Math.max(1, 0.08 / rms)) : 1; }
  g[nb] = g[nb - 1] || 1;
  for (let b = 0; b < nb; b++) { const e = Math.min(x.length, (b + 1) * B); for (let i = b * B; i < e; i++) { const f = (i - b * B) / B; x[i] = Math.max(-1, Math.min(1, x[i] * (g[b] * (1 - f) + g[b + 1] * f))); } }
}
function splitPoints(pcm, n) { // n parts, each cut placed in the quietest spot near the ideal position
  const cuts = [0], F = SR / 4; n = Math.max(1, n);
  for (let k = 1; k < n; k++) {
    const target = Math.floor(pcm.length * k / n), lo = Math.max(cuts[k - 1] + F, target - 20 * SR), hi = Math.min(pcm.length - F, target + 20 * SR);
    let best = target, bv = Infinity;
    for (let p = lo; p + F <= hi; p += F) { let s = 0; for (let i = p; i < p + F; i++) s += pcm[i] * pcm[i]; if (s < bv) { bv = s; best = p + (F >> 1); } }
    cuts.push(best);
  }
  cuts.push(pcm.length); return cuts;
}
function findGaps(pcm, segs) { // [start, end] seconds where there is sound but no transcript text
  const r = rmsEnv(pcm, 1600), nf = r.length;
  const floor = pct(r, 0.2), th = Math.min(0.03, Math.max(0.012, floor * 4));
  const spans = []; let st = -1, last = -1;
  for (let f = 0; f < nf; f++) if (r[f] > th) { if (st < 0) st = last = f; else if (f - last <= 6) last = f; else { spans.push([st, last + 1]); st = last = f; } }
  if (st >= 0) spans.push([st, last + 1]);
  const cov = segs.map(x => [x.start - 0.5, x.end + 0.5]).sort((a, b) => a[0] - b[0]), gaps = [];
  for (const [fa, fb] of spans) {
    let a = fa / 10; const b = fb / 10;
    for (const [cs, ce] of cov) { if (ce <= a) continue; if (cs >= b) break; if (cs > a && cs - a >= 1.2) gaps.push([a, cs]); a = Math.max(a, ce); if (a >= b) break; }
    if (b - a >= 1.2) gaps.push([a, b]);
  }
  let tot = 0; return gaps.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).filter(g => (tot += g[1] - g[0]) <= 900).sort((x, y) => x[0] - y[0]);
}
/*ENDGAP*/

// ---------- local engine: Whisper in background workers ----------
const workerSrc = `
let pipeline, env;
async function init(threads) {
  if (pipeline) return;
  let last;
  for (const v of ${JSON.stringify(TJS_VERSIONS)}) {
    try {
      const m = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@' + v);
      pipeline = m.pipeline; env = m.env; env.allowLocalModels = false;
      // Each worker gets its own slice of the CPU. Left unset, every worker grabs every core and they fight each other.
      const wa = env.backends && env.backends.onnx && env.backends.onnx.wasm;
      if (wa) { wa.numThreads = Math.max(1, threads | 0); wa.proxy = false; }
      return;
    }
    catch (e) { last = e; }
  }
  throw new Error('Could not load the engine from cdn.jsdelivr.net (' + (last && last.message || last) + '). Check your internet connection or firewall.');
}
let asr = null, key = '';
const noWords = {}; // models that cannot give word times: asking again would transcribe the whole file a second time for nothing
async function get(model, device, dtype, threads, post) {
  await init(threads);
  const k = model + device + dtype; if (asr && key === k) return asr; // thread count is fixed at init, so it is not part of the key
  asr = await pipeline('automatic-speech-recognition', model, {
    device, dtype,
    progress_callback: p => { if (p.status === 'progress') post({ type: 'load', pct: p.progress, file: p.file }); }
  });
  key = k; return asr;
}
async function run(d, device, dtype) {
  const post = m => self.postMessage(m);
  const t = await get(d.model, device, dtype, d.threads || 1, post);
  const stride = d.stride || 5, total = Math.max(1, Math.ceil(d.duration / (30 - stride * 2))); let n = 0;
  const opts = { return_timestamps: true, chunk_length_s: 30, stride_length_s: stride,
    chunk_callback: () => { n++; post({ type: 'prog', pct: Math.min(99, n / total * 100), device }); } };
  if (!d.model.endsWith('.en')) { opts.task = 'transcribe'; if (d.lang) opts.language = d.lang; }
  post({ type: 'prog', pct: 0, device });
  if (!noWords[d.model]) {
    try { const out = await t(d.audio, { ...opts, return_timestamps: 'word' }); return { out, words: true }; }
    catch (err) { noWords[d.model] = 1; n = 0; post({ type: 'prog', pct: 0, device }); }
  }
  const out = await t(d.audio, opts); return { out, words: false };
}
self.onmessage = async e => {
  const d = e.data;
  try {
    let out;
    let gpu = false;
    try { gpu = !!(self.navigator.gpu && await self.navigator.gpu.requestAdapter()); } catch (err) {}
    // Full precision on the GPU. Half precision is faster but returns an empty transcript on some
    // cards and model sizes, with no error to catch, so it is not worth the risk.
    if (gpu) { try { out = await run(d, 'webgpu', 'fp32'); } catch (err) { asr = null; self.postMessage({ type: 'note', text: 'WebGPU failed, using CPU (slower).' }); out = await run(d, 'wasm', 'q8'); } }
    else out = await run(d, 'wasm', 'q8');
    self.postMessage({ type: 'done', chunks: out.out.chunks || [{ text: out.out.text, timestamp: [0, d.duration] }], words: out.words });
  } catch (err) { self.postMessage({ type: 'error', text: String(err && err.message || err) }); }
};`
// Workers are kept alive between runs with the model still in memory, so the second file (and the
// second pass over the first) starts transcribing immediately instead of loading the model again.
let blobUrl = null; const idleWorkers = []; let idleTimer = 0;
function takeWorker() {
  if (!blobUrl) blobUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
  const w = idleWorkers.pop();
  if (w) { w.onmessage = null; w.onerror = null; return w; }
  return new Worker(blobUrl);
}
function freeWorkers(ws) { // only ever called with workers that finished cleanly
  clearTimeout(idleTimer);
  ws.forEach(w => { w.onmessage = null; w.onerror = null; if (idleWorkers.length < 8) idleWorkers.push(w); else w.terminate(); });
  idleTimer = setTimeout(() => idleWorkers.splice(0).forEach(w => w.terminate()), 120000); // give the memory back when idle
}

const warm = {}; // model -> promise: later files wait until the first one has the model loaded (avoids duplicate downloads)
async function localTranscribe(t, pcm, o) {
  let release = null;
  if (!warm[o.model]) warm[o.model] = new Promise(r => { release = r; }); else await warm[o.model];
  let gpu = false;
  try { gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (e) {}
  // On CPU, several workers each transcribe one part of the file in parallel.
  const maxW = /small/.test(o.model) ? 2 : 6;
  const share = Math.max(1, Math.floor(Math.max(1, (navigator.hardwareConcurrency || 4) - 1) / (o.par || 1))); // cores are shared between files running together
  const N = gpu || pcm.length < 90 * SR ? 1 : Math.max(1, Math.min(maxW, share));
  const cuts = splitPoints(pcm, N), pcts = new Array(N).fill(0), results = new Array(N), t0 = Date.now();
  let finished = 0, spawned = false, noteSaid = false, device = 'wasm';
  const mine = []; // this run's workers, handed back to the pool once they are all done
  const threads = Math.max(1, Math.floor(Math.max(1, (navigator.hardwareConcurrency || 4) - 1) / (N * (o.par || 1))));
  const stride = o.mode === 'fast' ? 3 : 5; // overlap between 30 s chunks; full overlap keeps accuracy up
  return new Promise((resolve, reject) => {
    t.abortFn = () => reject(cancelErr());
    const shown = () => { const p = pcts.reduce((x, y) => x + y, 0) / N; t.pct = p; t.msg = (t.label || 'Transcribing') + '… ' + Math.round(p) + '%, ' + eta(p, t0) + ' (' + (device === 'webgpu' ? 'GPU' : 'CPU, ' + N + ' parallel worker' + (N > 1 ? 's' : '')) + ')'; paint(t); };
    const start = i => {
      const a = cuts[i], b = cuts[i + 1];
      const slice = pcm.slice(a, b); let w;
      try { w = takeWorker(); } catch (e) { return reject(new Error('This browser blocked the background worker: ' + e.message)); }
      t.workers.push(w); mine.push(w);
      w.onerror = e => reject(new Error('The transcription engine failed to start: ' + (e.message || 'the browser blocked the background worker') + '. Try opening the folder with VS Code Live Server (http://localhost) instead of double-clicking index.html.'));
      w.onmessage = e => {
        const m = e.data;
        if (m.type === 'load') { if (i === 0) { t.pct = m.pct; t.msg = 'Downloading model… ' + Math.round(m.pct) + '% (first run only)'; paint(t); } }
        else if (m.type === 'prog') {
          pcts[i] = m.pct; device = m.device;
          if (i === 0 && !spawned) { spawned = true; if (release) release(); for (let k = 1; k < N; k++) start(k); }
          shown();
        }
        else if (m.type === 'note') say(m.text);
        else if (m.type === 'error') reject(new Error('Transcription failed: ' + m.text));
        else if (m.type === 'done') {
          const off = a / SR;
          results[i] = m.chunks.map(c => ({ text: c.text.trim(), start: (c.timestamp[0] ?? 0) + off, end: (c.timestamp[1] ?? (b - a) / SR) + off, word: !!m.words }))
            .filter(c => c.text);
          if (!m.words && !noteSaid) { noteSaid = true; say('Word-level timing is not available for this model, so timing is per sentence.'); }
          pcts[i] = 100; shown();
          if (++finished === N) {
            t.workers = t.workers.filter(x => mine.indexOf(x) < 0); freeWorkers(mine);
            resolve(results.flat().sort((x, y) => x.start - y.start));
          }
        }
      };
      w.postMessage({ model: o.model, lang: o.lang, audio: slice, duration: (b - a) / SR, threads, stride }, [slice.buffer]);
    };
    t.msg = 'Starting engine…'; paint(t); start(0);
  }).finally(() => { if (release) release(); });
}

// ---------- cloud engine: Groq Whisper API (optional, fast) ----------
/*WAV*/
function wavBlob(f) { // 16 kHz mono 16-bit WAV
  const n = f.length, b = new DataView(new ArrayBuffer(44)), w = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, 16000, true); b.setUint32(28, 32000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * 2, true);
  const pcm = new Int16Array(n); // written straight into a typed array: far quicker than a DataView call per sample
  for (let i = 0; i < n; i++) { const v = f[i]; pcm[i] = v >= 1 ? 32767 : v <= -1 ? -32767 : v * 32767; }
  return new Blob([b.buffer, pcm.buffer], { type: 'audio/wav' });
}
/*ENDWAV*/
async function cloudTranscribe(t, pcm, o) {
  if (!o.key) throw new Error('Enter your Groq API key first.');
  try { localStorage.setItem('groqKey', o.key); } catch (e) {}
  const n = Math.max(1, Math.ceil(pcm.length / (10 * 60 * SR))), cuts = splitPoints(pcm, n); let done = 0;
  t.ctl = new AbortController(); t.pct = 0; t.msg = (t.label || 'Transcribing') + ' in the cloud…'; paint(t);
  const parts = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const a = cuts[i], fd = new FormData();
    fd.append('file', wavBlob(pcm.subarray(a, cuts[i + 1])), 'part.wav');
    fd.append('model', o.mode === 'accurate' ? 'whisper-large-v3' : 'whisper-large-v3-turbo'); fd.append('response_format', 'verbose_json'); fd.append('timestamp_granularities[]', 'word'); fd.append('timestamp_granularities[]', 'segment');
    if (o.lang) fd.append('language', o.lang);
    let r;
    for (let k = 0; ; k++) {
      r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + o.key }, body: fd, signal: t.ctl.signal });
      if (r.status === 429 && k < 5) { await sleep((+r.headers.get('retry-after') || 5) * 1000); continue; }
      break;
    }
    if (!r.ok) throw new Error('Groq returned ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json(); t.pct = ++done / n * 100; paint(t);
    const W = (j.words || []).map(w => [w.word, w.start + a / SR, w.end + a / SR]);
    return (j.segments || []).map(c => {
      let s0 = c.start + a / SR, e0 = c.end + a / SR; const text = c.text.trim(), tk = text.split(/\s+/);
      let ws = W.filter(w => w[1] >= s0 - 0.05 && w[1] < e0);
      if (ws.length) { if (tk.length === ws.length) ws = ws.map((w, k) => [tk[k], w[1], w[2]]); s0 = ws[0][1]; e0 = ws[ws.length - 1][2]; }
      return { text, start: s0, end: e0, words: ws.length ? ws : undefined };
    }).filter(c => c.text);
  }));
  return parts.flat().sort((x, y) => x.start - y.start);
}

// ---------- queue ----------
function toSegs(items) { // words -> sentences (each keeps its exact word times)
  const out = []; let g = null;
  const flush = () => { if (g && g.length) out.push({ text: g.map(w => w[0]).join(' '), start: g[0][1], end: g[g.length - 1][2], spk: 0, words: g }); g = null; };
  for (const it of items) {
    if (!it.word) { flush(); out.push({ text: it.text, start: it.start, end: it.end, spk: 0, ...(it.words ? { words: it.words } : {}) }); continue; }
    const w = [it.text.trim(), it.start, it.end]; if (!w[0]) continue;
    if (g && (w[1] - g[g.length - 1][2] > 0.8 || g.length >= 25 || w[2] - g[0][1] > 15)) flush();
    (g = g || []).push(w);
    if (/[.?!…۔]$/.test(w[0])) flush();
  }
  flush(); return out;
}
async function makePlayable(t, pcm) {
  // Some files (e.g. variable-bitrate MP3) play on a slightly different timeline than the decoded audio.
  // Playing a copy made from the decoded audio keeps the transcript and the sound exactly in step.
  const blob = wavBlob(pcm); t.playUrl = URL.createObjectURL(blob); t.dur = pcm.length / SR;
  idb.putBlob(t.id + ':play', blob).catch(() => {}); persist(t);
  if (t === cur) { audio.pause(); audio.src = t.playUrl; }
}
function snapEdges(segs, pcm, r0) { // move sentence start/end to where the sound really begins/stops (after pauses)
  const r = r0 || rmsEnv(pcm, 160), nf = r.length;
  const th = Math.min(0.03, Math.max(0.01, pct(r, 0.2) * 4));
  const on = f => r[f] > th && r[f + 1] > th && r[f + 2] > th;
  segs.forEach((s, k) => {
    const prevEnd = k ? segs[k - 1].end : 0, nextStart = k + 1 < segs.length ? segs[k + 1].start : Infinity;
    if (s.start - prevEnd > 0.3) {
      for (let f = Math.floor(Math.max(s.start - 0.8, prevEnd) * 100); f < Math.min(nf - 3, Math.ceil((s.start + 0.5) * 100)); f++) if (on(f)) {
        const ns = Math.min(f / 100, s.end - 0.1); s.start = ns; if (s.words && s.words.length) s.words[0][1] = Math.min(ns, s.words[0][2]); break;
      }
    }
    if (nextStart - s.end > 0.3) {
      for (let f = Math.min(nf - 4, Math.floor(Math.min(s.end + 0.8, nextStart) * 100)); f >= Math.floor(Math.max(s.start + 0.1, s.end - 0.5) * 100); f--) if (on(f)) {
        const ne = Math.max((f + 1) / 100, s.start + 0.1); s.end = ne; if (s.words && s.words.length) { const w = s.words[s.words.length - 1]; w[2] = Math.max(ne, w[1]); } break;
      }
    }
  });
}
function compact(pcm) { // cut long silences before transcribing (big time saver); null if little would be saved
  const F = 1600, r = rmsEnv(pcm, F), nf = r.length;
  const th = Math.min(0.03, Math.max(0.006, pct(r, 0.2) * 3)), spans = []; let st = -1, last = -1;
  for (let f = 0; f < nf; f++) if (r[f] > th) { if (st < 0) st = last = f; else if (f - last <= 15) last = f; else { spans.push([st, last + 1]); st = last = f; } }
  if (st >= 0) spans.push([st, last + 1]);
  const merged = []; for (const [a, b] of spans) { const x = [Math.max(0, a - 4) * F, Math.min(nf, b + 4) * F], l = merged[merged.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else merged.push(x); }
  const kept = merged.reduce((n, x) => n + x[1] - x[0], 0); if (!merged.length || kept > 0.85 * pcm.length) return null;
  const out = new Float32Array(kept + SR * merged.length), map = []; let p = 0;
  for (const [a, b] of merged) { out.set(pcm.subarray(a, b), p); map.push({ g0: p / SR, len: (b - a) / SR, orig: a / SR }); p += b - a + SR; }
  return { out, map };
}
function remap(items, map) { // put times found in the shortened audio back onto the original timeline
  const res = [];
  for (const r of items) {
    const m = map.find(m => r.start >= m.g0 - 0.01 && r.start < m.g0 + m.len); if (!m) continue;
    const d = m.orig - m.g0;
    res.push({ ...r, start: r.start + d, end: Math.min(r.end + d, m.orig + m.len), words: r.words && r.words.map(w => [w[0], w[1] + d, w[2] + d]) });
  }
  return res;
}
function tighten(segs, pcm, r0) { // keep words on the voiced sound; drop lines that sit over silence (typical Whisper inventions)
  const r = r0 || rmsEnv(pcm, 160), nf = r.length;
  const th = Math.min(0.03, Math.max(0.01, pct(r, 0.2) * 4)), v = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) v[f] = r[f] > th ? 1 : 0;
  for (let f = 1; f < nf - 6; f++) if (!v[f] && v[f - 1]) for (let k = 1; k <= 6; k++) if (v[f + k]) { for (let j = 0; j < k; j++) v[f + j] = 1; break; }
  const frac = (a, b) => { const i0 = Math.max(0, Math.floor(a * 100)), i1 = Math.min(nf, Math.ceil(b * 100)); let c = 0; for (let i = i0; i < i1; i++) c += v[i]; return i1 > i0 ? c / (i1 - i0) : 0; };
  const kept = segs.filter(s => frac(s.start, s.end) >= 0.08);
  for (const s of kept) {
    if (!s.words || !s.words.length) continue;
    let prev = s.start;
    s.words = s.words.map(w => {
      let a = w[1], b = w[2], f0 = -1, f1 = -1;
      for (let i = Math.max(0, Math.floor(a * 100)); i <= Math.min(nf - 1, Math.ceil(b * 100)); i++) if (v[i]) { if (f0 < 0) f0 = i; f1 = i; }
      if (f0 >= 0) { a = Math.max(a, f0 / 100); b = Math.min(b, (f1 + 1) / 100); }
      a = Math.max(a, prev); b = Math.max(b, a + 0.04); prev = b; return [w[0], a, b];
    });
    s.start = s.words[0][1]; s.end = s.words[s.words.length - 1][2];
  }
  return kept;
}
async function recover(t, pcm, o, segs) { // second pass: transcribe only the sound that has no text yet
  const gaps = findGaps(pcm, segs); if (!gaps.length) return 0;
  const map = [], pieces = []; let pos = 0;
  for (const [a, b] of gaps) {
    const a0 = Math.max(0, Math.floor((a - 0.5) * SR)), b0 = Math.min(pcm.length, Math.ceil((b + 0.5) * SR));
    pieces.push(pcm.subarray(a0, b0)); map.push({ g0: pos / SR, len: (b0 - a0) / SR, orig: a0 / SR }); pos += b0 - a0 + SR;
  }
  const out = new Float32Array(pos); let p = 0; pieces.forEach(x => { out.set(x, p); p += x.length + SR; });
  t.workers.forEach(w => w.terminate()); t.workers = []; t.label = 'Checking for missed speech'; t.pct = 0; t.msg = t.label + '…'; paint(t);
  const items = await (o.eng === 'cloud' ? cloudTranscribe(t, out, o) : localTranscribe(t, out, o));
  const BAD = /^\W*(thanks for watching|you|bye|subtitles by.*)?\W*$/i; let added = 0; const mapped = remap(items, map);
  for (const c of toSegs(mapped)) {
    if (BAD.test(c.text) || segs.some(x => Math.min(x.end, c.end) - Math.max(x.start, c.start) > 0.5 * Math.max(0.5, c.end - c.start))) continue;
    c.rec = true; segs.push(c); added++;
  }
  segs.sort((x, y) => x.start - y.start); return added;
}
async function transcribe(t, o) {
  t.status = 'running'; t.pct = 0; t.msg = 'Decoding audio…'; t.label = 'Transcribing'; t.cancelled = false; update();
  try {
    const dec = await decode(t.file);
    if (t.cancelled) throw cancelErr();
    let chans = dec.chans && o.sides ? dec.chans : [dec.mono || mixdown(dec.chans)];
    if (Math.abs(chans[0].length / SR - t.dur) > 0.3 && !t.playUrl) await makePlayable(t, chans.length > 1 ? mixdown(chans) : chans[0]);
    const all = []; let rec = 0;
    const fast = o.mode === 'fast', skipSil = o.mode !== 'accurate', oo = fast ? { ...o, model: o.model.replace(/-(base|small)/, '-tiny') } : o;
    for (let c = 0; c < chans.length; c++) {
      const pcm = chans[c]; chans[c] = null;
      t.label = chans.length > 1 ? 'Transcribing side ' + (c + 1) + ' of ' + chans.length : 'Transcribing';
      normalize(pcm);
      const cp = skipSil ? compact(pcm) : null;
      let items = await (oo.eng === 'cloud' ? cloudTranscribe(t, cp ? cp.out : pcm, oo) : localTranscribe(t, cp ? cp.out : pcm, oo));
      if (cp) items = remap(items, cp.map);
      let segs = toSegs(items);
      if (!fast) try { rec += await recover(t, pcm, oo, segs); } catch (e) { if (e.name === 'AbortError' || t.cancelled) throw e; }
      const env = rmsEnv(pcm, 160);
      snapEdges(segs, pcm, env); segs = tighten(segs, pcm, env);
      segs.forEach(x => x.spk = c); all.push(...segs);
    }
    t.segs = all.sort((x, y) => x.start - y.start);
    t.status = 'done'; t.msg = '';
    say(t.segs.length ? t.file.name + ': transcript ready (' + t.segs.length + ' sections' + (rec ? '; ' + rec + ' recovered in a second check and marked with a green bar, please review them' : '') + ').' : t.file.name + ': no speech was detected.', t.segs.length ? 'ok' : 'err');
  } catch (e) {
    if (e.name === 'AbortError' || t.cancelled) { t.status = 'ready'; t.msg = ''; say(t.file.name + ': cancelled.'); }
    else { t.status = 'error'; t.msg = e.message; say(t.file.name + ': ' + e.message, 'err'); }
  } finally {
    t.workers.forEach(w => w.terminate()); t.workers = []; t.ctl = null; t.abortFn = null;
    if (t.status === 'done') persist(t);
    if (t === cur) render(); update();
  }
}
function enqueue(list) {
  const o = { eng: $('engine').value, model: $('model').value, lang: $('lang').value, key: $('key').value.trim(), par: +$('par').value || 1, sides: $('sides').checked, mode: $('mode').value };
  list.forEach(t => {
    if (t.dur <= 0 || t.status === 'running' || t.status === 'queued') return;
    t.status = 'queued'; t.msg = 'Waiting in queue…'; t.pct = 0; t.cancelled = false; t.opts = o; pending.push(t);
  });
  say(''); update(); pump();
}
function pump() {
  while (pending.length) {
    const t = pending[0];
    if (t.status !== 'queued') { pending.shift(); continue; }
    if (lanes >= (t.opts.par || 1)) break;
    pending.shift(); lanes++;
    transcribe(t, t.opts).finally(() => { lanes--; pump(); });
  }
}
$('goBtn').onclick = () => cur && enqueue([cur]);
$('goAll').onclick = () => enqueue(tabs.filter(t => t.dur > 0 && (t.status === 'ready' || t.status === 'error')));
$('cancelBtn').onclick = () => { if (cur) { cancelTab(cur); update(); } };
$('engine').onchange = () => { const c = $('engine').value === 'cloud'; $('keyRow').hidden = !c; $('model').disabled = c; };
try { $('key').value = localStorage.getItem('groqKey') || ''; } catch (e) {}

// ---------- transcript view ----------
function render() {
  const tr = $('tr'); tr.textContent = ''; nowIdx = -1; const t = cur;
  if (!t || !t.segs.length) {
    const p = document.createElement('p'); p.className = 'empty';
    p.textContent = !t ? 'Add one or more audio files to begin. Each file opens in its own tab.' : (t.status === 'running' || t.status === 'queued') ? 'This file is being transcribed. You can switch tabs meanwhile.' : 'Press Transcribe this file, or Transcribe all.';
    tr.append(p); search(); return;
  }
  t.segs.forEach(s => {
    const row = document.createElement('div'); row.className = 'seg'; row.dataset.sp = s.spk % 6;
    const b = document.createElement('button'); b.className = 't'; b.textContent = fmt(s.start); b.title = 'Jump to ' + fmt(s.start);
    b.onclick = () => { audio.currentTime = s.start; audio.play(); };
    const sel = document.createElement('select'); sel.className = 'spksel'; sel.setAttribute('aria-label', 'Speaker'); sel.onchange = () => { s.spk = +sel.value; row.dataset.sp = s.spk % 6; persist(t); };
    const x = document.createElement('div'); x.className = 'x'; x.contentEditable = 'true'; x.spellcheck = true;
    if (s.words) s.words.forEach((w, k) => { const sp = document.createElement('span'); sp.textContent = w[0]; x.append(sp); if (k < s.words.length - 1) x.append(' '); }); else x.textContent = s.text;
    x.onclick = e => { if (s.words) { const k = [...x.children].indexOf(e.target); if (k >= 0) audio.currentTime = s.words[k][1]; } };
    x.oninput = () => { s.text = x.innerText.replace(/\n/g, ' '); s.words = null; persist(t); };
    if (s.rec) { row.classList.add('rec'); row.title = 'Recovered in a second check for missed speech. Please review.'; }
    row.append(b, sel, x); tr.append(row);
  });
  fillSelects(); search();
}
function fillSelects() {
  if (!cur) return;
  document.querySelectorAll('.spksel').forEach((sel, i) => { sel.innerHTML = ''; cur.speakers.forEach((n, k) => sel.add(new Option(n, k))); sel.value = cur.segs[i].spk; });
}
function drawSpeakers() {
  const box = $('spk'); box.textContent = ''; if (!cur) return; const t = cur;
  t.speakers.forEach((n, i) => {
    const r = document.createElement('div'); r.className = 'row';
    const inp = document.createElement('input'); inp.type = 'text'; inp.value = n; inp.setAttribute('aria-label', 'Speaker name ' + (i + 1));
    inp.oninput = () => { t.speakers[i] = inp.value || 'Speaker ' + (i + 1); document.querySelectorAll('.spksel').forEach(s => { if (s.options[i]) s.options[i].text = t.speakers[i]; }); persist(t); };
    r.append(inp); box.append(r);
  });
}
$('addSpk').onclick = () => { if (!cur) return; cur.speakers.push('Speaker ' + (cur.speakers.length + 1)); persist(cur); drawSpeakers(); fillSelects(); };

function search() {
  const q = $('search').value.trim().toLowerCase(); hitIdx = []; hitPos = -1;
  [...$('tr').children].forEach((el, i) => { const h = !!q && !!cur && !!cur.segs[i] && cur.segs[i].text.toLowerCase().includes(q); el.classList.toggle('hit', h); if (h) hitIdx.push(i); });
  $('hits').textContent = q ? hitIdx.length + ' match' + (hitIdx.length === 1 ? '' : 'es') : '';
}
$('search').oninput = search;
$('search').onkeydown = e => { if (e.key === 'Enter' && hitIdx.length) { hitPos = (hitPos + 1) % hitIdx.length; $('tr').children[hitIdx[hitPos]].scrollIntoView({ block: 'center' }); } };

// ---------- export ----------
const spk = (t, s) => t.speakers[s.spk] || 'Speaker';
const asTxt = t => t.segs.map(s => '[' + fmt(s.start) + '] ' + spk(t, s) + ': ' + s.text).join('\n');
const asSrt = t => t.segs.map((s, i) => (i + 1) + '\n' + fmt(s.start, 1) + ' --> ' + fmt(Math.max(s.end, s.start + 0.5), 1) + '\n' + spk(t, s) + ': ' + s.text + '\n').join('\n');
const q = v => '"' + String(v).replace(/"/g, '""') + '"';
const asCsv = t => '\ufeffstart,end,speaker,text\r\n' + t.segs.map(s => [fmt(s.start, 1), fmt(s.end, 1), q(spk(t, s)), q(s.text)].join(',')).join('\r\n');
/*DOCX*/
// ---- one Word document holding every finished file, each under its own heading ----
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const xmlEsc = v => String(v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function wRun(r) { // one stretch of text with its own look
  const pr = [];
  if (r.b) pr.push('<w:b/>');
  if (r.i) pr.push('<w:i/>');
  if (r.color) pr.push('<w:color w:val="' + r.color + '"/>');
  if (r.sz) pr.push('<w:sz w:val="' + r.sz + '"/><w:szCs w:val="' + r.sz + '"/>');
  return '<w:r>' + (pr.length ? '<w:rPr>' + pr.join('') + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + xmlEsc(r.t) + '</w:t></w:r>';
}
function wPara(runs, o) {
  o = o || {}; const pr = [];
  if (o.style) pr.push('<w:pStyle w:val="' + o.style + '"/>');
  if (o.page) pr.push('<w:pageBreakBefore/>');
  return '<w:p>' + (pr.length ? '<w:pPr>' + pr.join('') + '</w:pPr>' : '') + (runs || []).map(wRun).join('') + '</w:p>';
}
const DOCX_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
const DOCX_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const DOCX_DOCRELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
const DOCX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="' + W_NS + '">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="360" w:after="160"/></w:pPr>' +
  '<w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style></w:styles>';
function docxBlob(list) { // every finished file in one .docx, split by the audio file name
  const body = [wPara([{ t: 'Transcripts' }], { style: 'Title' }),
    wPara([{ t: list.length + (list.length === 1 ? ' file' : ' files') + '  ·  ' + new Date().toLocaleString(), color: '707070', sz: 18 }])];
  list.forEach((t, k) => {
    body.push(wPara([{ t: t.file.name }], { style: 'Heading1', page: k > 0 })); // each file starts a new page
    if (!t.segs.length) { body.push(wPara([{ t: 'No speech was detected in this file.', i: true, color: '707070' }])); return; }
    t.segs.forEach(s => body.push(wPara([
      { t: '[' + fmt(s.start) + ']  ' + spk(t, s) + ': ', b: true, color: '1F3864' },
      { t: s.text }
    ])));
  });
  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="' + W_NS + '"><w:body>' + body.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>';
  const enc = new TextEncoder();
  // [Content_Types].xml has to be the first entry in the package, so the order here matters.
  const files = [['[Content_Types].xml', DOCX_TYPES], ['_rels/.rels', DOCX_RELS], ['word/_rels/document.xml.rels', DOCX_DOCRELS],
    ['word/document.xml', doc], ['word/styles.xml', DOCX_STYLES]].map(x => ({ name: x[0], data: enc.encode(x[1]) }));
  return new Blob([makeZip(files)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
/*ENDDOCX*/
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); return name; }
function save(ext, text, type) { if (cur) say('Downloaded ' + download(new Blob([text], { type }), safe(cur.file.name) + ext), 'ok'); }
$('shiftBtn').onclick = () => {
  const d = parseFloat($('shiftBy').value); if (!cur || !d) return;
  const sh = v => Math.max(0, v + d);
  cur.segs.forEach(s => { s.start = sh(s.start); s.end = sh(s.end); if (s.words) s.words = s.words.map(w => [w[0], sh(w[1]), sh(w[2])]); });
  persist(cur); render(); say('All timestamps in this file moved by ' + d + ' s.', 'ok');
};
$('txt').onclick = () => save('.txt', asTxt(cur), 'text/plain');
$('srt').onclick = () => save('.srt', asSrt(cur), 'application/x-subrip');
$('csv').onclick = () => save('.csv', asCsv(cur), 'text/csv');
$('copy').onclick = async () => {
  const text = asTxt(cur);
  try { await navigator.clipboard.writeText(text); }
  catch (e) { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
  say('Transcript copied to the clipboard.', 'ok');
};

// ---------- save as folders (audio + TXT + SRT + CSV per call) ----------
/*ZIP*/
function crc32(u8) {
  const t = crc32.t || (crc32.t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  let r = -1; for (let i = 0; i < u8.length; i++) r = (r >>> 8) ^ t[(r ^ u8[i]) & 255]; return (r ^ -1) >>> 0;
}
function makeZip(files) { // stored (uncompressed) zip; names may include a folder path
  const enc = new TextEncoder(), parts = [], cd = []; let off = 0;
  for (const f of files) {
    const n = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true); h.setUint16(26, n.length, true);
    parts.push(h.buffer, n, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true); c.setUint16(28, n.length, true); c.setUint32(42, off, true);
    cd.push(c.buffer, n); off += 30 + n.length + sz;
  }
  const size = cd.reduce((a, b) => a + b.byteLength, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cd, e.buffer], { type: 'application/zip' });
}
/*ENDZIP*/
/*MARK*/
// ---- put the transcript inside the saved audio as markers (MP3: ID3 chapters + synced lyrics, WAV: cue points) ----
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; a.forEach(x => { o.set(x, p); p += x.length; }); return o; };
const be32 = n => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const le32 = n => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const lat = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
const u16 = s => { const b = new Uint8Array(s.length * 2 + 2); b[0] = 0xFF; b[1] = 0xFE; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[2 + i * 2] = c & 255; b[3 + i * 2] = c >> 8; } return b; };
const z2 = new Uint8Array(2);
const id3f = (id, data) => cat(lat(id), be32(data.length), z2, data);
const mlabel = (t, s) => (spk(t, s) + ': ' + s.text).replace(/\s+/g, ' ').slice(0, 160);
const esc = x => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function xmpPacket(t, rate) { // Adobe XMP "Cue" markers, start times in samples
  const lis = t.segs.map(s => '<rdf:li rdf:parseType="Resource"><xmpDM:startTime>' + Math.round(s.start * rate) + '</xmpDM:startTime><xmpDM:duration>0</xmpDM:duration><xmpDM:name>' + esc(mlabel(t, s)) + '</xmpDM:name><xmpDM:comment>' + esc(s.text) + '</xmpDM:comment></rdf:li>').join('');
  return '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/"><xmpDM:Tracks><rdf:Bag><rdf:li rdf:parseType="Resource"><xmpDM:trackName>Transcript</xmpDM:trackName><xmpDM:trackType>Cue</xmpDM:trackType><xmpDM:frameRate>f' + rate + '</xmpDM:frameRate><xmpDM:markers><rdf:Seq>' + lis + '</rdf:Seq></xmpDM:markers></rdf:li></rdf:Bag></xmpDM:Tracks></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
}
function id3Tag(t, rate) {
  const ms = v => Math.round(Math.max(0, v) * 1000), one = new Uint8Array([1]), nul = new Uint8Array(1);
  const frames = [id3f('TIT2', cat(one, u16(safe(t.file.name)), z2)),
    id3f('USLT', cat(one, lat('eng'), u16('Transcript'), z2, u16(asTxt(t)))),
    id3f('SYLT', cat(one, lat('eng'), new Uint8Array([2, 1]), u16('Transcript'), z2, ...t.segs.map(s => cat(u16(mlabel(t, s) + '\n'), z2, be32(ms(s.start))))))];
  frames.push(id3f('PRIV', cat(lat('XMP'), nul, new TextEncoder().encode(xmpPacket(t, rate)))));
  t.segs.forEach((s, i) => frames.push(id3f('CHAP', cat(lat('ch' + i), nul, be32(ms(s.start)), be32(Math.max(ms(s.end), ms(s.start) + 1)), be32(0xFFFFFFFF), be32(0xFFFFFFFF), id3f('TIT2', cat(one, u16(mlabel(t, s)), z2))))));
  const body = cat(...frames), n = body.length;
  return cat(new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]), body);
}
async function markMp3(t) {
  const h = new Uint8Array(await t.file.slice(0, 10).arrayBuffer()); let start = 0;
  if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) start = 10 + (((h[6] & 127) << 21) | ((h[7] & 127) << 14) | ((h[8] & 127) << 7) | (h[9] & 127)) + (h[5] & 0x10 ? 10 : 0);
  const hd = new Uint8Array(await t.file.slice(start, start + 65536).arrayBuffer()); let rate = 44100;
  for (let i = 0; i + 3 < hd.length; i++) if (hd[i] === 0xFF && (hd[i + 1] & 0xE0) === 0xE0 && ((hd[i + 1] >> 1) & 3) === 1 && ((hd[i + 2] >> 2) & 3) < 3) {
    const ver = (hd[i + 1] >> 3) & 3, tab = ver === 3 ? [44100, 48000, 32000] : ver === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
    rate = tab[(hd[i + 2] >> 2) & 3]; break;
  }
  return new Blob([id3Tag(t, rate), t.file.slice(start)], { type: 'audio/mpeg' });
}
async function markWav(t) {
  const f = t.file, rd = async (a, b) => new Uint8Array(await f.slice(a, b).arrayBuffer()), chr = u => String.fromCharCode(...u);
  const h = await rd(0, 12); if (chr(h.slice(0, 4)) !== 'RIFF' || chr(h.slice(8, 12)) !== 'WAVE') return f;
  let pos = 12, rate = 0; const keep = [];
  while (pos + 8 <= f.size) {
    const ch = await rd(pos, pos + 8), id = chr(ch.slice(0, 4)), len = new DataView(ch.buffer).getUint32(4, true), end = Math.min(f.size, pos + 8 + len + (len & 1));
    if (id === 'fmt ') rate = new DataView((await rd(pos + 8, pos + 16)).buffer).getUint32(4, true);
    const old = id === 'cue ' || (id === 'LIST' && len >= 4 && chr(await rd(pos + 8, pos + 12)) === 'adtl');
    if (!old) keep.push(f.slice(pos, end));
    pos = end;
  }
  if (!rate || !t.segs.length) return f;
  const enc = new TextEncoder(), pts = [], labs = [];
  t.segs.forEach((s, i) => {
    const smp = Math.round(s.start * rate), tx = enc.encode(mlabel(t, s)), len = 4 + tx.length + 1;
    pts.push(cat(le32(i + 1), le32(smp), lat('data'), le32(0), le32(0), le32(smp)));
    labs.push(cat(lat('labl'), le32(len), le32(i + 1), tx, new Uint8Array(1 + (len & 1))));
  });
  const cue = cat(lat('cue '), le32(4 + 24 * pts.length), le32(pts.length), ...pts), ls = cat(lat('adtl'), ...labs), list = cat(lat('LIST'), le32(ls.length), ls);
  const total = 4 + keep.reduce((n, b) => n + b.size, 0) + cue.length + list.length;
  return new Blob([cat(lat('RIFF'), le32(total), lat('WAVE')), ...keep, cue, list], { type: 'audio/wav' });
}
const asLabels = t => t.segs.map(s => s.start.toFixed(3) + '\t' + s.end.toFixed(3) + '\t' + mlabel(t, s)).join('\n'); // Audacity: File > Import > Labels
const tcode = v => Math.floor(v / 60) + ':' + (v % 60).toFixed(3).padStart(6, '0');
const asAudition = t => ['Name\tStart\tDuration\tTime Format\tType\tDescription'].concat(t.segs.map(s => mlabel(t, s) + '\t' + tcode(s.start) + '\t0:00.000\tdecimal\tCue\t')).join('\n'); // Adobe Audition marker list
function pcmWav(chs) { // 16 kHz, 16-bit, mono or stereo
  const nch = chs.length, n = chs[0].length, b = new DataView(new ArrayBuffer(44 + n * 2 * nch)), w = (o, x) => [...x].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + n * 2 * nch, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, nch, true);
  b.setUint32(24, SR, true); b.setUint32(28, SR * 2 * nch, true); b.setUint16(32, 2 * nch, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * 2 * nch, true);
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) b.setInt16(44 + (i * nch + c) * 2, Math.max(-1, Math.min(1, chs[c][i])) * 32767, true);
  return new Blob([b], { type: 'audio/wav' });
}
async function auditionWav(t) { // WAV copy with cue markers: the format Adobe Audition always reads
  const d = await decode(t.file), w = new File([pcmWav(d.chans || [d.mono])], safe(t.file.name) + '_markers.wav');
  return markWav({ ...t, file: w });
}
async function markedAudio(t) {
  try { if (/\.mp3$/i.test(t.file.name)) return await markMp3(t); if (/\.wav$/i.test(t.file.name)) return await markWav(t); } catch (e) {}
  return t.file;
}
/*ENDMARK*/
async function bundle(t, used) {
  const b0 = safe(t.file.name); let base = b0, k = 2; while (used.has(base)) base = b0 + ' (' + k++ + ')'; used.add(base);
  const audioBlob = $('mark').checked ? await markedAudio(t) : t.file;
  return { base, files: [[t.file.name, audioBlob], [base + '.txt', new Blob([asTxt(t)])], [base + '.srt', new Blob([asSrt(t)])], [base + '.csv', new Blob([asCsv(t)])], [base + '.labels.txt', new Blob([asLabels(t)])], [base + '.audition-markers.csv', new Blob([asAudition(t)])]].concat($('wavcopy').checked ? [[base + '_markers.wav', await auditionWav(t)]] : []) };
}
async function saveFolders(list, zipName) {
  if (!list.length) return;
  say('Preparing the files…'); const used = new Set(), sets = []; for (const t of list) sets.push(await bundle(t, used));
  if (window.showDirectoryPicker) {
    try {
      const root = await showDirectoryPicker({ mode: 'readwrite' });
      for (const s of sets) {
        const dir = await root.getDirectoryHandle(s.base, { create: true });
        for (const [name, blob] of s.files) { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(blob); await w.close(); }
      }
      return say('Saved ' + sets.length + ' folder' + (sets.length > 1 ? 's' : '') + ', each with the audio and its transcripts.', 'ok');
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const files = [];
  for (const s of sets) for (const [name, blob] of s.files) files.push({ name: s.base + '/' + name, data: new Uint8Array(await blob.arrayBuffer()) });
  say('Downloaded ' + download(makeZip(files), zipName + '.zip') + '. Extract it to get the folders.', 'ok');
}
$('folder').onclick = () => cur && saveFolders([cur], safe(cur.file.name));
$('saveAll').onclick = () => saveFolders(tabs.filter(x => x.status === 'done'), 'transcripts');
$('docAll').onclick = () => {
  const list = tabs.filter(x => x.status === 'done'); if (!list.length) return;
  say('Downloaded ' + download(docxBlob(list), 'transcripts.docx') + ': ' + list.length + (list.length === 1 ? ' file' : ' files') + ', each under its own name.', 'ok');
};

drawSpeakers(); render(); update();

// restore everything saved before the last refresh
(async () => {
  try { navigator.storage?.persist?.(); } catch (e) {}
  try {
    const metas = (await idb.allMeta()).sort((a, b) => a.added - b.added); let want = '', pick = null, n = 0;
    try { want = localStorage.getItem('curTab') || ''; } catch (e) {}
    for (const m of metas) {
      const b = await idb.getBlob(m.id); if (!b) { idb.del(m.id).catch(() => {}); continue; }
      const f = b.name ? b : new File([b], m.name, { type: m.mime }), pb = await idb.getBlob(m.id + ':play');
      const t = { id: m.id, added: m.added, file: f, url: URL.createObjectURL(f), dur: m.dur, segs: m.segs || [], speakers: m.speakers || ['Speaker 1', 'Speaker 2'], status: (m.segs || []).length ? 'done' : 'ready', pct: 0, msg: '', workers: [], stored: true, playUrl: pb ? URL.createObjectURL(pb) : undefined };
      tabs.push(t); n++; if (t.id === want) pick = t;
    }
    if (n) { select(pick || cur || tabs[0]); say('Restored ' + n + ' saved file' + (n > 1 ? 's' : '') + ' with their transcripts.', 'ok'); }
  } catch (e) {}
})();
