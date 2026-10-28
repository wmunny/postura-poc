import { APP_VERSION, CONFIG, FILTROS, GEMINI } from './config.js';
import { analyzeVideo } from './pose.js';
import { ANGLE_DEFS, GROUPS, computeSeries, anglesForFrame, stats } from './angles.js';
import { RAZONES } from './filters.js';
import { AngleChart } from './charts.js';
import { drawOverlay, Viewer3D } from './render.js';
import { exportAnglesCSV, exportLandmarksCSV, exportJSON } from './export.js';
import { setApiKey, hasApiKey } from './gemini.js';
import { runB, runC, viewB, viewC } from './argon.js';

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
  filtros: true,
  scenario: 'A',
  views: {},          // A, B, C: { times, series, ... }
  argon: { B: null, C: null },
  computed: null,     // vista activa
  charts: [],
  abort: null,
  argonAbort: null,
};

const SCENARIO_NAMES = { A: 'A · MediaPipe', B: 'B · Argon solo', C: 'C · Mixto' };
const LABEL = Object.fromEntries(ANGLE_DEFS.map((d) => [d.id, d.label]));
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
});
$('#btn-cancel').addEventListener('click', () => state.abort?.abort());

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

function recompute() {
  if (!state.frames) return;
  const A = computeSeries(state.frames, {
    mode: state.mode, width: state.meta.width, height: state.meta.height,
    smoothWindow: state.smooth, filtros: state.filtros,
  });
  state.views = { A };
  if (state.argon.B) state.views.B = viewB(state.argon.B, A.times);
  if (state.argon.C) state.views.C = viewC(state.argon.C, A);
  if (!state.views[state.scenario]) state.scenario = 'A';
  document.querySelectorAll('[data-scenario]').forEach((b) => {
    b.classList.toggle('on', b.dataset.scenario === state.scenario);
    b.disabled = !state.views[b.dataset.scenario];
  });

  state.computed = state.views[state.scenario];
  const ghost = state.scenario === 'A' ? A.raw : A.series;
  state.charts.forEach((c) => c.setData(state.computed.times, state.computed.series, ghost));
  renderGhostNote();
  renderStats();
  renderFilters(A);
  renderCompare();
  syncToVideo();
}

function renderGhostNote() {
  const notes = {
    A: state.filtros ? 'Línea tenue: MediaPipe sin filtrar. Lo que ves por encima es lo que queda tras los filtros.' : '',
    B: 'Línea tenue: escenario A (MediaPipe). Los ángulos de Argon son anatómicos en 3D: compáralos con el modo «Ángulos 3D».',
    C: 'Línea tenue: escenario A antes de la revisión de Argon.',
  };
  let note = notes[state.scenario];
  if (state.scenario === 'C' && state.argon.C && state.argon.C.mode !== state.mode) {
    note += ` La revisión se hizo con ángulos ${state.argon.C.mode.toUpperCase()}: cambia a ese modo para compararla bien.`;
  }
  $('#ghost-note').textContent = note;
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
  const keys = state.filtros ? Object.keys(RAZONES) : ['visibilidad'];
  const head = `<tr><th>Ángulo</th>${keys.map((k) => `<th>${RAZONES[k]}</th>`).join('')}<th>Cobertura final</th></tr>`;
  const rows = ANGLE_DEFS.map((d) => {
    const q = A.quality[d.id];
    return `<tr><td><i class="sw side-${d.side}"></i>${d.label}</td>${keys.map((k) => `<td${q[k] ? '' : ' class="good"'}>${q[k]}</td>`).join('')}<td>${coverage(A.series[d.id])} %</td></tr>`;
  }).join('');
  $('#filters-table').innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
  $('#filters-details').querySelector('summary').textContent = state.filtros
    ? 'Qué han descartado los filtros (escenario A)'
    : 'Filtros desactivados: solo se descartan los puntos con visibilidad baja';
}

function meanAbsDiff(a, b) {
  let s = 0, n = 0;
  a.forEach((v, i) => { if (v != null && b[i] != null) { s += Math.abs(v - b[i]); n++; } });
  return n ? s / n : null;
}

function renderCompare() {
  const others = ['B', 'C'].filter((k) => state.views[k]);
  $('#compare').hidden = !others.length;
  if (!others.length) return;
  const all = ['A', ...others];
  const head = `<tr><th>Ángulo</th>${all.map((k) => `<th>Media ${k}</th>`).join('')}${all.map((k) => `<th>P95 ${k}</th>`).join('')}`
    + `${all.map((k) => `<th>Cobertura ${k}</th>`).join('')}${others.map((k) => `<th>|${k} − A|</th>`).join('')}</tr>`;
  const rows = ANGLE_DEFS.map((d) => {
    const s = Object.fromEntries(all.map((k) => [k, state.views[k].series[d.id]]));
    const st = Object.fromEntries(all.map((k) => [k, stats(s[k])]));
    return `<tr><td><i class="sw side-${d.side}"></i>${d.label}</td>`
      + all.map((k) => `<td>${deg(st[k].mean)}</td>`).join('')
      + all.map((k) => `<td>${deg(st[k].p95)}</td>`).join('')
      + all.map((k) => `<td>${coverage(s[k])} %</td>`).join('')
      + others.map((k) => `<td>${deg(meanAbsDiff(s[k], s.A))}</td>`).join('')
      + '</tr>';
  }).join('');
  $('#compare-table').innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
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
  drawOverlay(overlay, video, frame);
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
$('#filters').addEventListener('change', (e) => { state.filtros = e.target.checked; recompute(); });

// ---------- 4. Escenarios B y C (Gemini 4 Argon) ----------
function argonStatus(msg, isError = false) {
  const el = $('#argon-status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function resetArgon() {
  state.argonAbort?.abort();
  state.argon = { B: null, C: null };
  state.scenario = 'A';
  for (const k of ['B', 'C']) { $(`#context-${k}`).hidden = true; $(`#context-${k}`).innerHTML = ''; }
  argonStatus('');
}

function tokensOf(u) {
  if (!u) return null;
  return u.total_tokens ?? u.totalTokenCount ?? (((u.input_tokens ?? 0) + (u.output_tokens ?? 0)) || null);
}

async function runArgon(kind) {
  if (!hasApiKey()) { openKeyDialog(); return; }
  if (!state.views.A) return;
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
    const r = kind === 'B' ? await runB(args) : await runC({ ...args, base: state.views.A, mode: state.mode });
    state.argon[kind] = r;
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
      argonStatus(`Error de Gemini: ${err.message}.${hint}`, true);
    }
  } finally {
    $('#btn-run-b').disabled = $('#btn-run-c').disabled = false;
    $('#btn-argon-cancel').hidden = true;
  }
}
$('#btn-run-b').addEventListener('click', () => runArgon('B'));
$('#btn-run-c').addEventListener('click', () => runArgon('C'));
$('#btn-argon-cancel').addEventListener('click', () => state.argonAbort?.abort());

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
    <p class="meta">${r.fps} fotogramas/s · razonamiento ${{ low: 'bajo', medium: 'medio', high: 'alto' }[r.thinking] || esc(r.thinking)} ·${r.segundos.toFixed(0)} s${tok ? ` · ${tok.toLocaleString('es-ES')} tokens` : ''}${kind === 'C' ? ` · revisó ángulos ${r.mode.toUpperCase()}` : ''}</p>
    <p>${esc(j.resumen)}</p>`;
  if (kind === 'C') {
    html += `<h4>Tramos revisados</h4>${list(j.revisiones, (x) => `${span(x)} · <strong>${esc(LABEL[x.articulacion] || x.articulacion)}</strong> · ${esc(x.veredicto)}: ${esc(x.motivo)}`, 'Argon no ha encontrado tramos implausibles.')}`;
    const cam = state.views.C?.cambios;
    if (cam) {
      const sum = (k) => Object.values(cam).reduce((a, b) => a + b[k], 0);
      html += `<p class="meta">Fotogramas corregidos: ${sum('corregidos')} · descartados: ${sum('descartados')} · dudosos sin corrección: ${sum('dudosos')}</p>`;
    }
  }
  html += `<h4>Tarea</h4><p>${esc(c.tarea)}</p>
    <h4>Fases</h4>${list(c.fases, (x) => `${span(x)} · ${esc(x.descripcion)}`, 'Sin fases.')}
    <h4>Carga y agarre</h4><p>${c.carga?.manipula ? `${esc(c.carga.descripcion)}${c.carga.peso_estimado_kg != null ? ` · ~${esc(c.carga.peso_estimado_kg)} kg` : ''}` : 'No manipula carga.'} · Agarre: ${pretty(c.agarre)}</p>
    <h4>Tronco</h4>
    <p>Torsión:</p>${list(c.torsion_tronco, (x) => `${span(x)}${x.grados_aprox != null ? ` · ~${esc(x.grados_aprox)}°` : ''}`, 'No detectada.')}
    <p>Inclinación lateral:</p>${list(c.inclinacion_lateral_tronco, (x) => `${span(x)}${x.grados_aprox != null ? ` · ~${esc(x.grados_aprox)}°` : ''}`, 'No detectada.')}
    <h4>Piernas</h4><p>${pretty(c.piernas)}</p>
    <h4>Oclusiones</h4>${list(j.oclusiones, (x) => `${span(x)} · ${esc((x.articulaciones || []).map((a) => LABEL[a] || a).join(', '))} · ${esc(x.motivo)}`, 'No se han señalado.')}
    <h4>Observaciones</h4><p>${esc(c.observaciones)}</p>
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
  filtros: state.filtros ? FILTROS : null,
  escenarios: Object.fromEntries(['B', 'C'].filter((k) => state.argon[k]).map((k) => {
    const { json, fps, thinking, segundos, mode } = state.argon[k];
    return [k, { modelo: GEMINI.modelo, fps, razonamiento: thinking, segundos, modo: mode ?? null, respuesta: json }];
  })),
}));

// Para depuración y pruebas automáticas
window.__poc = { state, anglesForFrame };
