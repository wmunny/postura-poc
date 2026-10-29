import { APP_VERSION, CONFIG, FILTROS, GEMINI } from './config.js';
import { analyzeVideo } from './pose.js';
import { makeSkeletonVideos } from './overlay-video.js';
import { seriesMetrics, overlap } from './metrics.js';
import { ANGLE_DEFS, GROUPS, computeSeries, anglesForFrame, stats } from './angles.js';
import { RAZONES } from './filters.js';
import { AngleChart } from './charts.js';
import { drawOverlay, Viewer3D } from './render.js';
import { exportAnglesCSV, exportLandmarksCSV, exportJSON, downloadBlob, baseName } from './export.js';
import { setApiKey, hasApiKey } from './gemini.js';
import { runB, runC, viewB, viewC, argonFrames, argonPoseAt, PUNTOS, VEREDICTOS } from './argon.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const overlay = $('#overlay');
const viewer = new Viewer3D($('#view3d'));

const state = {
  file: null,
  url: null,
  frames: null,
  meta: null,
  mode: '2d',
  smooth: 5,
  scenario: 'A0',
  views: {},          // A0 (bruto), A1 (filtros mecánicos), B, C: { times, series, ... }
  argon: { B: null, C: null },
  argonPoses: null,   // puntos 2D de Argon (escenario B) con el formato de MediaPipe
  videos: null,       // { ladoALado, superpuesto }: vídeos con el esqueleto de MediaPipe en bruto
  videoJob: null,
  videoAbort: null,
  computed: null,     // vista activa
  charts: [],
  abort: null,
  argonAbort: null,
};

const SCENARIO_NAMES = { A0: 'A · Bruto', A1: 'A · Filtros mecánicos', B: 'B · Argon solo', C: 'C · Argon revisor' };
const LABEL = Object.fromEntries(ANGLE_DEFS.map((d) => [d.id, d.label]));
// codo_izq -> «Codo izq.»
const PUNTO_LABEL = Object.fromEntries(Object.keys(PUNTOS).map((k) => {
  const [n, s] = k.split('_');
  const name = n === 'muneca' ? 'muñeca' : n;
  return [k, `${name[0].toUpperCase()}${name.slice(1)} ${s}.`];
}));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

$('#app-version').textContent = APP_VERSION;
$('#mp-version').textContent = CONFIG.tasksVisionVersion;

// ---------- 0. Clave de Gemini (solo en memoria) ----------
const keyDialog = $('#key-dialog');
function updateKeyUI() {
  const ok = hasApiKey();
  $('#key-status').textContent = ok ? 'Gemini: clave en memoria' : 'Gemini: sin clave';
  $('#key-badge').classList.toggle('ok', ok);
  $('#key-skip').textContent = ok ? 'Olvidar la clave' : 'Continuar sin Gemini';
}
function openKeyDialog() {
  updateKeyUI();
  $('#key-input').value = '';
  keyDialog.showModal();
  $('#key-input').focus();
}
$('#key-ok').addEventListener('click', () => {
  const v = $('#key-input').value.trim();
  if (!v) { $('#key-input').focus(); return; }
  setApiKey(v);
  keyDialog.close();
});
$('#key-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#key-ok').click(); });
$('#key-skip').addEventListener('click', () => {
  if (hasApiKey()) setApiKey(null);
  keyDialog.close();
});
keyDialog.addEventListener('close', () => { $('#key-input').value = ''; updateKeyUI(); });
$('#key-badge').addEventListener('click', openKeyDialog);
openKeyDialog();

// ---------- 1. Carga del vídeo ----------
function setFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(file.name)) {
    setStatus('El archivo no parece un vídeo.', true);
    return;
  }
  if (state.url) URL.revokeObjectURL(state.url);
  state.file = file;
  state.url = URL.createObjectURL(file);
  state.frames = null;
  resetArgon();
  resetVideos();
  $('#file-name').hidden = false;
  $('#file-name').textContent = `${file.name} · ${(file.size / 1e6).toFixed(1)} MB`;
  video.src = state.url;
  video.load();
  $('#step-results').hidden = true;
  $('#step-argon').hidden = true;
  setStatus('Cargando vídeo…');
  $('#btn-analyze').disabled = true;
}

video.addEventListener('loadedmetadata', () => {
  if (!state.file) return;
  const d = video.duration;
  if (!Number.isFinite(d) || d <= 0) {
    setStatus('No se puede leer la duración del vídeo. Prueba a convertirlo a MP4 (H.264).', true);
    return;
  }
  setStatus(`Vídeo listo: ${d.toFixed(1)} s · ${video.videoWidth}×${video.videoHeight} px.`);
  $('#btn-analyze').disabled = false;
});
video.addEventListener('error', () => {
  if (!state.file) return;
  setStatus('Este navegador no puede reproducir el vídeo (por ejemplo, HEVC/H.265 de iPhone en Windows, o AVI de cámara). Conviértelo a MP4 H.264 o, en el iPhone, activa «Más compatible» en Ajustes › Cámara › Formatos.', true);
});

$('#file-record').addEventListener('change', (e) => setFile(e.target.files[0]));
$('#file-pick').addEventListener('change', (e) => setFile(e.target.files[0]));
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));

function setStatus(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

// ---------- 2. Análisis ----------
$('#btn-analyze').addEventListener('click', async () => {
  const model = $('#model').value;
  const fps = Number($('#fps').value);
  state.abort = new AbortController();
  $('#btn-analyze').disabled = true;
  $('#btn-cancel').hidden = false;
  $('#progress').hidden = false;
  $('#progress-bar').style.width = '0%';
  $('#progress-text').textContent = 'Descargando modelo y preparando el motor…';
  setStatus('');
  resetVideos();
  let ok = false;

  // Mostramos el vídeo durante el análisis: el usuario ve el esqueleto en directo.
  $('#step-results').hidden = false;
  $('#stage').classList.add('busy');
  video.controls = false;
  const t0 = performance.now();

  try {
    const { frames, delegate } = await analyzeVideo(video, {
      model, fps, signal: state.abort.signal,
      onProgress: ({ done, total, eta, frame }) => {
        $('#progress-bar').style.width = `${(100 * done) / total}%`;
        $('#progress-text').textContent = `Fotograma ${done} de ${total} · quedan ~${Math.ceil(eta)} s`;
        drawOverlay(overlay, video, frame);
        viewer.setFrame(frame);
      },
    });
    const secs = (performance.now() - t0) / 1000;
    state.frames = frames;
    state.meta = {
      fileName: state.file.name,
      duracion_s: Math.round(video.duration * 1000) / 1000,
      width: video.videoWidth,
      height: video.videoHeight,
      fpsAnalizados: fps,
      modelo: `pose_landmarker_${model}`,
      delegate,
      tiempoProceso_s: Math.round(secs * 10) / 10,
      fecha: new Date().toISOString(),
      app: `postura-poc ${APP_VERSION}`,
      tasksVision: CONFIG.tasksVisionVersion,
      userAgent: navigator.userAgent,
    };
    setStatus(`Análisis completado en ${secs.toFixed(1)} s (${delegate}).`);
    showResults();
    ok = true;
  } catch (err) {
    if (err.name === 'AbortError') setStatus('Análisis cancelado.');
    else {
      console.error(err);
      setStatus(`Error durante el análisis: ${err.message || err}. Si estás en una red corporativa, puede que bloquee la descarga del modelo (ver README, «modo sin CDN»).`, true);
    }
    if (!state.frames) $('#step-results').hidden = true;
  } finally {
    $('#btn-analyze').disabled = false;
    $('#btn-cancel').hidden = true;
    $('#progress').hidden = true;
    $('#stage').classList.remove('busy');
    video.controls = true;
  }
  if (ok) generateVideos().catch(() => {});
});
$('#btn-cancel').addEventListener('click', () => state.abort?.abort());

// ---------- Vídeos con el esqueleto de MediaPipe (para Argon y para descargar) ----------
function videoStatus(msg, isError = false) {
  const el = $('#video-status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function resetVideos() {
  state.videoAbort?.abort();
  state.videos = null;
  state.videoJob = null;
  $('#dl-side').disabled = $('#dl-over').disabled = true;
  videoStatus('');
}

/** Genera (una sola vez por análisis) los dos vídeos con el esqueleto en bruto. */
function generateVideos() {
  if (state.videos) return Promise.resolve(state.videos);
  if (state.videoJob) return state.videoJob;
  const frames = state.frames;
  const ctrl = new AbortController();
  state.videoAbort = ctrl;
  state.videoJob = (async () => {
    $('#stage').classList.add('busy');
    video.controls = false;
    $('#btn-run-c').disabled = true;
    const t0 = performance.now();
    try {
      const v = await makeSkeletonVideos(video, frames, {
        fps: state.meta.fpsAnalizados, signal: ctrl.signal,
        onProgress: (p) => videoStatus(`Generando los vídeos con el esqueleto de MediaPipe… ${Math.round(p * 100)} %`),
      });
      state.videos = v;
      $('#dl-side').disabled = $('#dl-over').disabled = false;
      const mb = (b) => (b.size / 1e6).toFixed(1);
      videoStatus(`Vídeos listos en ${((performance.now() - t0) / 1000).toFixed(0)} s · lado a lado ${mb(v.ladoALado)} MB (es el que revisa Argon en C) · superpuesto ${mb(v.superpuesto)} MB.`);
      return v;
    } catch (err) {
      state.videoJob = null;
      if (err.name !== 'AbortError') {
        console.error(err);
        videoStatus(`No se han podido generar los vídeos: ${err.message || err}`, true);
      }
      throw err;
    } finally {
      if (state.videoAbort === ctrl) {
        $('#stage').classList.remove('busy');
        video.controls = true;
        $('#btn-run-c').disabled = false;
        video.currentTime = 0;
      }
    }
  })();
  return state.videoJob;
}
$('#dl-side').addEventListener('click', () => state.videos && downloadBlob(`${baseName(state.meta)}_argon_lado_a_lado.mp4`, state.videos.ladoALado));
$('#dl-over').addEventListener('click', () => state.videos && downloadBlob(`${baseName(state.meta)}_esqueleto.mp4`, state.videos.superpuesto));

// ---------- 3. Resultados ----------
function buildCharts() {
  const box = $('#charts');
  box.innerHTML = '';
  state.charts = GROUPS.map((g) => {
    const series = ANGLE_DEFS.filter((d) => d.group === g.id)
      .map((d) => ({ id: d.id, label: d.side === 'C' ? d.label : (d.side === 'L' ? 'Izq.' : 'Dch.'), side: d.side }));
    const chart = new AngleChart(box, { title: g.label, series });
    chart.onHover = (t) => state.charts.forEach((c) => c.setHover(t));
    chart.onSeek = (t) => { video.currentTime = t; };
    return chart;
  });
}

const baseOpts = () => ({ mode: state.mode, width: state.meta.width, height: state.meta.height });

function recompute() {
  if (!state.frames) return;
  const A0 = computeSeries(state.frames, { ...baseOpts(), smoothWindow: state.smooth });
  const A1 = computeSeries(state.frames, { ...baseOpts(), smoothWindow: state.smooth, filtros: true });
  state.views = { A0, A1 };
  if (state.argon.B) state.views.B = viewB(state.argon.B, A0.times, baseOpts());
  if (state.argon.C) state.views.C = viewC(state.argon.C, state.frames, { ...baseOpts(), smoothWindow: state.smooth });
  if (!state.views[state.scenario]) state.scenario = 'A0';
  document.querySelectorAll('[data-scenario]').forEach((b) => {
    b.classList.toggle('on', b.dataset.scenario === state.scenario);
    b.disabled = !state.views[b.dataset.scenario];
  });

  state.computed = state.views[state.scenario];
  const ghost = state.scenario === 'A0' ? null : A0.series;
  const bands = state.scenario === 'C' ? state.computed.bandas : null;
  state.charts.forEach((c, k) => c.setData(state.computed.times, state.computed.series, ghost, bands?.[GROUPS[k].id]));
  renderGhostNote();
  renderStats();
  renderFilters(A1);
  renderCompare();
  syncToVideo();
}

function renderGhostNote() {
  const notes = {
    A0: 'MediaPipe tal como sale: solo se descartan los puntos que el propio MediaPipe da por poco visibles.',
    A1: 'Línea tenue: MediaPipe en bruto. Lo que ves por encima es lo que queda tras los filtros mecánicos.',
    B: state.mode === '2d'
      ? 'Línea tenue: MediaPipe en bruto. En 2D, los ángulos de B se calculan con los puntos que Argon marca en cada fotograma (el esqueleto amarillo del vídeo).'
      : 'Línea tenue: MediaPipe en bruto. En 3D, son los ángulos anatómicos que estima Argon directamente.',
    C: 'Línea tenue: MediaPipe en bruto. Zonas sombreadas: tramos en que Argon ha rechazado algún punto (cruz roja en el vídeo). Los huecos de menos de 1 s se rellenan; los más largos se dejan vacíos.',
  };
  $('#ghost-note').textContent = notes[state.scenario];
}

function renderQuality() {
  const f = state.frames;
  const detected = f.filter((x) => x.lm).length;
  const pct = (100 * detected) / f.length;
  const core = [11, 12, 23, 24, 25, 26, 27, 28];
  const vis = f.filter((x) => x.lm).flatMap((x) => core.map((i) => x.lm[i][3]));
  const meanVis = vis.length ? vis.reduce((a, b) => a + b, 0) / vis.length : 0;
  const m = state.meta;
  const kpi = (val, label, warn) => `<div class="kpi${warn ? ' warn' : ''}"><b>${val}</b><span>${label}</span></div>`;
  $('#quality').innerHTML =
    kpi(`${pct.toFixed(0)} %`, 'fotogramas con persona', pct < 80) +
    kpi(`${(meanVis * 100).toFixed(0)} %`, 'visibilidad media tronco y piernas', meanVis < 0.7) +
    kpi(`${f.length}`, `fotogramas · ${m.fpsAnalizados}/s`) +
    kpi(`${m.tiempoProceso_s} s`, `proceso · ${m.delegate}`);
}

const deg = (v) => (v == null ? '—' : `${v.toFixed(0)}°`);
const coverage = (s) => Math.round((100 * s.filter((v) => v != null).length) / (s.length || 1));

function renderStats() {
  const { series } = state.computed;
  $('#stats-scenario').textContent = `· ${SCENARIO_NAMES[state.scenario]}`;
  const rows = ANGLE_DEFS.map((d) => {
    const s = stats(series[d.id]);
    return `<tr><td><i class="sw side-${d.side}"></i><span title="${d.help}">${d.label}</span></td>
      <td>${deg(s.mean)}</td><td>${deg(s.p50)}</td><td>${deg(s.p95)}</td><td>${deg(s.min)}</td><td>${deg(s.max)}</td><td>${coverage(series[d.id])} %</td></tr>`;
  }).join('');
  $('#stats-table').innerHTML = `<thead><tr><th>Ángulo</th><th>Media</th><th>Mediana</th><th>P95</th><th>Mín.</th><th>Máx.</th><th>Cobertura</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderFilters(A) {
  const keys = Object.keys(RAZONES);
  const head = `<tr><th>Ángulo</th>${keys.map((k) => `<th>${RAZONES[k]}</th>`).join('')}<th>Cobertura final</th></tr>`;
  const rows = ANGLE_DEFS.map((d) => {
    const q = A.quality[d.id];
    return `<tr><td><i class="sw side-${d.side}"></i>${d.label}</td>${keys.map((k) => `<td${q[k] ? '' : ' class="good"'}>${q[k]}</td>`).join('')}<td>${coverage(A.series[d.id])} %</td></tr>`;
  }).join('');
  $('#filters-table').innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
}

/** Tabla de ganancia: MediaPipe en bruto, con filtros mecánicos y con la revisión de Argon (C). */
function renderCompare() {
  const opts = { ...baseOpts(), smoothWindow: 1 };
  const S = {
    bruto: computeSeries(state.frames, opts).series,
    filtros: computeSeries(state.frames, { ...opts, filtros: true }).series,
  };
  if (state.argon.C) S.argon = viewC(state.argon.C, state.frames, opts).series;
  const cols = Object.keys(S);
  const NAMES = { bruto: 'Bruto', filtros: 'Filtros', argon: 'Argon' };
  const times = state.views.A0.times;
  const n0 = (v) => (v == null ? '—' : v.toFixed(0));

  const rowsData = ANGLE_DEFS.map((d) => {
    const m = Object.fromEntries(cols.map((k) => [k, seriesMetrics(S[k][d.id], times, d.group)]));
    const o = S.argon ? overlap(S.bruto[d.id], S.filtros[d.id], S.argon[d.id]) : null;
    return { d, m, o };
  });
  const cell = (m, key, fmt) => cols.map((k) => `<td>${fmt(m[k][key])}</td>`).join('');
  const row = (label, m, o, cls = '') => `<tr${cls}><td>${label}</td>`
    + cell(m, 'fluctuacion', n0) + cell(m, 'saltos', String) + cell(m, 'fueraRango', String)
    + cell(m, 'cobertura', (v) => `${v.toFixed(0)} %`)
    + (o ? `<td>${o.soloReglas}</td><td>${o.soloArgon}</td><td>${o.ambos}</td>` : '') + '</tr>';

  // Fila de totales: media de fluctuación y cobertura, suma del resto.
  const mean = (arr) => { const v = arr.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const tot = Object.fromEntries(cols.map((k) => [k, {
    fluctuacion: mean(rowsData.map((r) => r.m[k].fluctuacion)),
    saltos: rowsData.reduce((a, r) => a + r.m[k].saltos, 0),
    fueraRango: rowsData.reduce((a, r) => a + r.m[k].fueraRango, 0),
    cobertura: mean(rowsData.map((r) => r.m[k].cobertura)),
  }]));
  const totO = S.argon ? ['soloReglas', 'soloArgon', 'ambos'].reduce((acc, k) => ({ ...acc, [k]: rowsData.reduce((a, r) => a + r.o[k], 0) }), {}) : null;

  const sub = cols.map((k) => `<th>${NAMES[k]}</th>`).join('');
  const head = `<tr><th rowspan="2">Ángulo</th>`
    + `<th class="grp" colspan="${cols.length}">Fluctuación (°/s)</th><th class="grp" colspan="${cols.length}">Saltos imposibles</th>`
    + `<th class="grp" colspan="${cols.length}">Fuera de rango</th><th class="grp" colspan="${cols.length}">Cobertura</th>`
    + (S.argon ? '<th class="grp" colspan="3">Fotogramas tocados</th>' : '') + '</tr>'
    + `<tr>${sub}${sub}${sub}${sub}${S.argon ? '<th>Solo reglas</th><th>Solo Argon</th><th>Ambos</th>' : ''}</tr>`;
  const body = rowsData.map((r) => row(`<i class="sw side-${r.d.side}"></i>${r.d.label}`, r.m, r.o)).join('')
    + row('Total', tot, totO, ' class="total"');
  $('#compare-table').innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
}

function frameIndexAt(t) {
  const fr = state.frames;
  let lo = 0, hi = fr.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (fr[m].t < t) lo = m + 1; else hi = m; }
  if (lo > 0 && Math.abs(fr[lo - 1].t - t) < Math.abs(fr[lo].t - t)) lo--;
  return lo;
}

function syncToVideo() {
  if (!state.frames || !state.computed) return;
  const t = video.currentTime;
  const i = frameIndexAt(t);
  const frame = state.frames[i];
  const argon = state.argonPoses && $('#show-argon').checked
    ? argonPoseAt(state.argonPoses, state.argon.B.fps, t) : null;
  const rejected = state.scenario === 'C' ? state.views.C?.rejected[i] : null;
  drawOverlay(overlay, video, frame, { showMP: $('#show-mp').checked, argon, rejected });
  viewer.setFrame(frame);
  state.charts.forEach((c) => c.setPlayhead(t));
  $('#cur-time').textContent = `· ${t.toFixed(2)} s`;
  const { series } = state.computed;
  $('#now-table').innerHTML = ANGLE_DEFS.map((d) => {
    const v = series[d.id][i];
    return `<tr><td><i class="sw side-${d.side}"></i> ${d.label}</td><td>${v == null ? '—' : v.toFixed(0) + '°'}</td></tr>`;
  }).join('');
}

function loop() {
  syncToVideo();
  if (!video.paused && !video.ended) {
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(loop);
    else requestAnimationFrame(loop);
  }
}
video.addEventListener('play', loop);
video.addEventListener('seeked', () => { if (!$('#stage').classList.contains('busy')) syncToVideo(); });
new ResizeObserver(() => { if (state.computed) syncToVideo(); }).observe(overlay);

function showResults() {
  buildCharts();
  renderQuality();
  recompute();
  $('#step-argon').hidden = false;
  video.currentTime = 0;
}

document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
  state.mode = b.dataset.mode;
  recompute();
}));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === b));
  viewer.setView(b.dataset.view);
}));
document.querySelectorAll('[data-scenario]').forEach((b) => b.addEventListener('click', () => {
  state.scenario = b.dataset.scenario;
  recompute();
}));
$('#smooth').addEventListener('change', (e) => { state.smooth = Number(e.target.value); recompute(); });
$('#show-mp').addEventListener('change', syncToVideo);
$('#show-argon').addEventListener('change', syncToVideo);

// ---------- 4. Escenarios B y C (Gemini 4 Argon) ----------
function argonStatus(msg, isError = false) {
  const el = $('#argon-status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function resetArgon() {
  state.argonAbort?.abort();
  state.argon = { B: null, C: null };
  state.argonPoses = null;
  state.scenario = 'A0';
  $('#show-argon').checked = false;
  $('#show-argon').disabled = true;
  $('#argon-skel-note').textContent = 'Ejecuta el escenario B para ver dónde sitúa Argon cada articulación.';
  for (const k of ['B', 'C']) { $(`#context-${k}`).hidden = true; $(`#context-${k}`).innerHTML = ''; }
  argonStatus('');
}

function tokensOf(u) {
  if (!u) return null;
  return u.total_tokens ?? u.totalTokenCount ?? (((u.input_tokens ?? 0) + (u.output_tokens ?? 0)) || null);
}

async function runArgon(kind) {
  if (!hasApiKey()) { openKeyDialog(); return; }
  if (!state.views.A0) return;
  state.argonAbort = new AbortController();
  $('#btn-run-b').disabled = $('#btn-run-c').disabled = true;
  $('#btn-argon-cancel').hidden = false;
  const args = {
    file: state.file,
    duration: video.duration,
    fps: Number($('#argon-fps').value),
    thinking: $('#argon-thinking').value,
    signal: state.argonAbort.signal,
    onStatus: (m) => argonStatus(m),
  };
  argonStatus('Preparando el vídeo…');
  try {
    let r;
    if (kind === 'B') r = await runB(args);
    else {
      argonStatus('Preparando el vídeo con el esqueleto de MediaPipe…');
      const v = await generateVideos();
      const file = new File([v.ladoALado], `${baseName(state.meta)}_argon_lado_a_lado.mp4`, { type: 'video/mp4' });
      r = await runC({ ...args, file });
    }
    state.argon[kind] = r;
    if (kind === 'B') showArgonSkeleton(r);
    state.scenario = kind;
    recompute();
    renderContext(kind);
    const tok = tokensOf(r.usage);
    argonStatus(`Escenario ${kind} listo en ${r.segundos.toFixed(0)} s${tok ? ` · ${tok.toLocaleString('es-ES')} tokens` : ''}.`);
  } catch (err) {
    if (err.name === 'AbortError') argonStatus('Cancelado.');
    else {
      console.error(err);
      const hint = err.status === 400 && /key/i.test(err.message) ? ' Revisa la clave.'
        : err.status === 401 || err.status === 403 ? ' La clave no es válida o no tiene acceso a este modelo.'
        : err.status === 404 ? ` El modelo ${GEMINI.modelo} no está disponible para esta clave.`
        : err.status === 429 ? ' Se ha superado la cuota; espera un poco o revisa el plan.'
        : '';
      argonStatus(`Error de Gemini: ${err.message.replace(/\.$/, '')}.${hint}`, true);
    }
  } finally {
    $('#btn-run-b').disabled = $('#btn-run-c').disabled = false;
    $('#btn-argon-cancel').hidden = true;
  }
}
$('#btn-run-b').addEventListener('click', () => runArgon('B'));
$('#btn-run-c').addEventListener('click', () => runArgon('C'));
$('#btn-argon-cancel').addEventListener('click', () => state.argonAbort?.abort());

function showArgonSkeleton(r) {
  state.argonPoses = argonFrames(r);
  const n = state.argonPoses.length;
  const marked = state.argonPoses.reduce((a, f) => a + f.lm.filter((p) => p[3] > 0).length, 0);
  $('#show-argon').disabled = false;
  $('#show-argon').checked = true;
  $('#argon-skel-note').textContent = n
    ? `${n} fotogramas vistos por Argon · ${Math.round((100 * marked) / (n * 14))} % de las articulaciones situadas. Cada esqueleto se mantiene hasta la muestra siguiente; pausa el vídeo para comparar.`
    : 'Argon no ha devuelto puntos.';
}

const fmtT = (t) => `<button class="tlink" type="button" data-t="${Number(t) || 0}">${(Number(t) || 0).toFixed(1)} s</button>`;
const span = (x) => `${fmtT(x.inicio)}–${(Number(x.fin) || 0).toFixed(1)} s`;
const list = (items, fn, empty) => (items?.length ? `<ul>${items.map((x) => `<li>${fn(x)}</li>`).join('')}</ul>` : `<p class="muted">${empty}</p>`);
const pretty = (s) => esc(String(s ?? '').replace(/_/g, ' '));

function renderContext(kind) {
  const r = state.argon[kind];
  const j = r.json, c = j.contexto || {};
  const tok = tokensOf(r.usage);
  let html = `<div class="context">
    <h3>${SCENARIO_NAMES[kind]}</h3>
    <p class="meta">${r.fps} fotogramas/s · razonamiento ${{ low: 'bajo', medium: 'medio', high: 'alto' }[r.thinking] || esc(r.thinking)} · ${r.segundos.toFixed(0)} s${tok ? ` · ${tok.toLocaleString('es-ES')} tokens` : ''}</p>
    <p>${esc(j.resumen)}</p>`;
  if (kind === 'C') {
    const revs = (j.revisiones || []).slice().sort((a, b) => a.inicio - b.inicio);
    html += `<h4>Tramos corregidos</h4>${list(revs, (x) => `<span class="xmark">✕</span>${span(x)} · <strong>${esc(PUNTO_LABEL[x.articulacion] || x.articulacion)}</strong> · ${esc(VEREDICTOS[x.veredicto] || x.veredicto)}: ${esc(x.motivo)}`, 'Argon no ha encontrado fallos en el esqueleto.')}`;
    const cam = state.views.C?.cambios;
    if (cam) {
      const sum = (k) => Object.values(cam).reduce((a, b) => a + b[k], 0);
      html += `<p class="meta">Valores de ángulo descartados: ${sum('descartados')} · huecos de menos de 1 s rellenados: ${sum('rellenados')} fotogramas (suma de todas las articulaciones).</p>`;
    }
  }
  html += `<h4>Tarea</h4><p>${esc(c.tarea)}</p>
    <h4>Fases</h4>${list(c.fases, (x) => `${span(x)} · ${esc(x.descripcion)}`, 'Sin fases.')}
    <h4>Carga y agarre</h4><p>${c.carga?.manipula ? `${esc(c.carga.descripcion)}${c.carga.peso_estimado_kg != null ? ` · ~${esc(c.carga.peso_estimado_kg)} kg` : ''}` : 'No manipula carga.'} · Agarre: ${pretty(c.agarre)}</p>
    <h4>Tronco</h4>
    <p>Torsión:</p>${list(c.torsion_tronco, (x) => `${span(x)}${x.grados_aprox != null ? ` · ~${esc(x.grados_aprox)}°` : ''}`, 'No detectada.')}
    <p>Inclinación lateral:</p>${list(c.inclinacion_lateral_tronco, (x) => `${span(x)}${x.grados_aprox != null ? ` · ~${esc(x.grados_aprox)}°` : ''}`, 'No detectada.')}
    <h4>Piernas</h4><p>${pretty(c.piernas)}</p>`;
  if (kind === 'B') {
    html += `<h4>Oclusiones</h4>${list(j.oclusiones, (x) => `${span(x)} · ${esc((x.articulaciones || []).map((a) => LABEL[a] || a).join(', '))} · ${esc(x.motivo)}`, 'No se han señalado.')}`;
  }
  html += `<h4>Observaciones</h4><p>${esc(c.observaciones)}</p>
  </div>`;
  const box = $(`#context-${kind}`);
  box.innerHTML = html;
  box.hidden = false;
}
document.querySelector('.context-grid').addEventListener('click', (e) => {
  const b = e.target.closest('.tlink');
  if (b) { video.currentTime = Number(b.dataset.t); video.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
});

// ---------- Exportación ----------
$('#exp-angles').addEventListener('click', () => exportAnglesCSV(state.meta, state.computed.times, state.computed.series, `${state.mode}_${state.scenario}`));
$('#exp-landmarks').addEventListener('click', () => exportLandmarksCSV(state.meta, state.frames));
$('#exp-json').addEventListener('click', () => exportJSON(state.meta, state.frames, {
  filtros: FILTROS,
  escenarios: Object.fromEntries(['B', 'C'].filter((k) => state.argon[k]).map((k) => {
    const { json, fps, thinking, segundos } = state.argon[k];
    return [k, { modelo: GEMINI.modelo, fps, razonamiento: thinking, segundos, respuesta: json }];
  })),
}));

// Para depuración y pruebas automáticas
window.__poc = { state, anglesForFrame };
