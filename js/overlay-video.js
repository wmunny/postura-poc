// Vídeos con el esqueleto de MediaPipe en bruto, generados en el navegador (WebCodecs + mp4-muxer).
//
//  - Lado a lado: a la izquierda el fotograma original y a la derecha el mismo fotograma con el
//    esqueleto y el tiempo impreso. Es lo que revisa Gemini 4 Argon en el escenario C.
//  - Superpuesto: una sola vista con el esqueleto encima, para grabar o publicar.
//
// Cada fotograma del vídeo nuevo corresponde a un instante analizado por MediaPipe (mismas marcas
// de tiempo), así que los tiempos que cite Argon cuadran con la serie sin desfases.

import { CONFIG, VISIBILITY_THRESHOLD, VIDEO_ESQUELETO } from './config.js';
import { CONNECTIONS, seek } from './pose.js';

// Colores fijos (no dependen del tema claro/oscuro): son los que se explican a Argon.
export const COLORES = { L: '#2a78d6', R: '#eb6834', C: '#f2f2f2' };

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Esqueleto grueso, solo con las articulaciones que MediaPipe da por visibles. */
function drawSkeleton(ctx, frame, x, y, w, h) {
  if (!frame?.lm) return;
  const P = frame.lm.map((p) => [x + p[0] * w, y + p[1] * h, p[3] >= VISIBILITY_THRESHOLD]);
  const lw = Math.max(3, w / 130);
  ctx.lineCap = 'round';
  for (const [a, b, s] of CONNECTIONS) {
    if (!P[a][2] || !P[b][2]) continue;
    for (const [color, width] of [['#000', lw + 3], [COLORES[s], lw]]) {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(P[a][0], P[a][1]); ctx.lineTo(P[b][0], P[b][1]); ctx.stroke();
    }
  }
  for (const i of [7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if (!P[i][2]) continue;
    ctx.beginPath(); ctx.arc(P[i][0], P[i][1], lw * 1.2, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.stroke();
  }
}

function drawTime(ctx, t, x, y, size) {
  const label = `${t.toFixed(2)} s`;
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(x, y, tw + size, size * 1.6);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, x + size / 2, y + size * 0.8);
}

/** Primer perfil H.264 que el navegador puede codificar a ese tamaño. */
async function pickCodec(width, height, bitrate, framerate) {
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42001f']) {
    const config = { codec, width, height, bitrate, framerate, avc: { format: 'avc' } };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch { /* probar el siguiente */ }
  }
  throw new Error('Este navegador no puede codificar vídeo H.264 (WebCodecs). Usa Chrome o Edge recientes.');
}

async function makeTrack(Mp4, width, height, fps) {
  const bitrate = Math.round(width * height * fps * VIDEO_ESQUELETO.bitsPorPixel);
  const config = await pickCodec(width, height, bitrate, fps);
  const muxer = new Mp4.Muxer({
    target: new Mp4.ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let error = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { error = e; },
  });
  encoder.configure(config);
  const canvas = new OffscreenCanvas(width, height);
  return {
    canvas, ctx: canvas.getContext('2d'), width, height,
    async add(t, dur, key) {
      if (error) throw error;
      const vf = new VideoFrame(this.canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(dur * 1e6) });
      encoder.encode(vf, { keyFrame: key });
      vf.close();
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    },
    async finish() {
      await encoder.flush();
      if (error) throw error;
      encoder.close();
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    },
  };
}

/**
 * Genera los dos vídeos recorriendo `video` en los instantes de `frames`.
 * @returns {Promise<{ladoALado: Blob, superpuesto: Blob}>}
 */
export async function makeSkeletonVideos(video, frames, { fps, onProgress, signal } = {}) {
  if (!('VideoEncoder' in window)) throw new Error('Este navegador no admite WebCodecs. Usa Chrome o Edge recientes.');
  const Mp4 = await import(CONFIG.mp4MuxerUrl);
  const vw = video.videoWidth, vh = video.videoHeight;
  const k = Math.min(1, VIDEO_ESQUELETO.anchoMaximo / vw, VIDEO_ESQUELETO.altoMaximo / vh);
  const hw = even(vw * k), hh = even(vh * k);
  const k2 = Math.min(1, VIDEO_ESQUELETO.anchoMaximoSuperpuesto / Math.max(vw, vh));
  const ow = even(vw * k2), oh = even(vh * k2);

  const side = await makeTrack(Mp4, hw * 2, hh, fps);
  const over = await makeTrack(Mp4, ow, oh, fps);
  const step = 1 / fps;
  video.pause();
  for (let i = 0; i < frames.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    const f = frames[i];
    await seek(video, f.t);
    const key = i % (fps * 2) === 0;

    side.ctx.drawImage(video, 0, 0, hw, hh);
    side.ctx.drawImage(video, hw, 0, hw, hh);
    side.ctx.fillStyle = '#000'; side.ctx.fillRect(hw - 1, 0, 2, hh);
    drawSkeleton(side.ctx, f, hw, 0, hw, hh);
    drawTime(side.ctx, f.t, hw + 8, 8, Math.max(14, hh / 26));
    await side.add(f.t, step, key);

    over.ctx.drawImage(video, 0, 0, ow, oh);
    drawSkeleton(over.ctx, f, 0, 0, ow, oh);
    drawTime(over.ctx, f.t, 8, 8, Math.max(14, oh / 30));
    await over.add(f.t, step, key);

    if (i % 5 === 0 || i === frames.length - 1) onProgress?.((i + 1) / frames.length);
  }
  return { ladoALado: await side.finish(), superpuesto: await over.finish() };
}
