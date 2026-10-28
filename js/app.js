import { APP_VERSION, CONFIG } from './config.js';
import { analyzeVideo } from './pose.js';
import { ANGLE_DEFS, GROUPS, computeSeries, anglesForFrame, stats } from './angles.js';
import { AngleChart } from './charts.js';
import { drawOverlay, Viewer3D } from './render.js';
import { exportAnglesCSV, exportLandmarksCSV, exportJSON } from './export.js';

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
  computed: null,
  charts: [],
  abort: null,
};

$('#app-version').textContent = APP_VERSION;
$('#mp-version').textContent = CONFIG.tasksVisionVersion;

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
  $('#file-name').hidden = false;
  $('#file-name').textContent = `${file.name} · ${(file.size / 1e6).toFixed(1)} MB`;
  video.src = state.url;
  video.load();
  $('#step-results').hidden = true;
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
  setStatus('Este navegador no puede reproducir el vídeo (¿HEVC/H.265 de iPhone en Windows?). Prueba con Safari, o exporta a MP4 H.264 («Más compatible» en Ajustes › Cámara › Formatos).', true);
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
      app: `vitaly-postura-poc ${APP_VERSION}`,
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
  state.computed = computeSeries(state.frames, {
    mode: state.mode, width: state.meta.width, height: state.meta.height, smoothWindow: state.smooth,
  });
  const { times, series } = state.computed;
  state.charts.forEach((c) => c.setData(times, series));
  renderStats();
  syncToVideo();
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

function renderStats() {
  const { series } = state.computed;
  const rows = ANGLE_DEFS.map((d) => {
    const s = stats(series[d.id]);
    const cov = Math.round((100 * s.n) / series[d.id].length);
    const f = (v) => (v == null ? '—' : `${v.toFixed(0)}°`);
    return `<tr><td><i class="sw side-${d.side}"></i><span title="${d.help}">${d.label}</span></td>
      <td>${f(s.mean)}</td><td>${f(s.p50)}</td><td>${f(s.p95)}</td><td>${f(s.min)}</td><td>${f(s.max)}</td><td>${cov} %</td></tr>`;
  }).join('');
  $('#stats-table').innerHTML = `<thead><tr><th>Ángulo</th><th>Media</th><th>Mediana</th><th>P95</th><th>Mín.</th><th>Máx.</th><th>Cobertura</th></tr></thead><tbody>${rows}</tbody>`;
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
$('#smooth').addEventListener('change', (e) => { state.smooth = Number(e.target.value); recompute(); });

$('#exp-angles').addEventListener('click', () => exportAnglesCSV(state.meta, state.computed.times, state.computed.series, state.mode));
$('#exp-landmarks').addEventListener('click', () => exportLandmarksCSV(state.meta, state.frames));
$('#exp-json').addEventListener('click', () => exportJSON(state.meta, state.frames));

// Para depuración y pruebas automáticas
window.__poc = { state, anglesForFrame };
