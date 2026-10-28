// Cliente mínimo de la API de Gemini (Interactions API) para el navegador.
//
// La clave vive solo en esta variable del módulo: no se guarda en localStorage, cookies,
// IndexedDB ni en la URL, y se envía únicamente en la cabecera x-goog-api-key.
// Al recargar o cerrar la pestaña desaparece.

const API = 'https://generativelanguage.googleapis.com';
// El base64 crece un 33 %: por encima de este tamaño el vídeo se sube con la Files API.
const INLINE_MAX = 14 * 1024 * 1024;

let apiKey = null;
const uploads = new WeakMap(); // File -> { uri, mime } (solo en memoria, para reutilizar entre B y C)

export const setApiKey = (k) => { apiKey = k?.trim() || null; };
export const hasApiKey = () => apiKey != null;

const headers = (extra = {}) => ({ 'x-goog-api-key': apiKey, ...extra });

async function apiError(res) {
  let msg = `${res.status} ${res.statusText}`;
  try {
    const j = await res.json();
    if (j.error?.message) msg = j.error.message;
  } catch { /* respuesta sin JSON */ }
  const e = new Error(msg);
  e.status = res.status;
  return e;
}

export function mimeOf(file) {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop().toLowerCase();
  return { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/avi', mkv: 'video/x-matroska' }[ext] || 'video/mp4';
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function uploadFile(file, signal, onStatus) {
  const mime = mimeOf(file);
  onStatus?.('Subiendo el vídeo a la API de Gemini…');
  const start = await fetch(`${API}/upload/v1beta/files`, {
    method: 'POST', signal,
    headers: headers({
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ file: { display_name: file.name } }),
  });
  if (!start.ok) throw await apiError(start);
  const url = start.headers.get('x-goog-upload-url');
  if (!url) throw new Error('La API no devolvió la dirección de subida. Prueba con un vídeo de menos de 14 MB.');
  const up = await fetch(url, {
    method: 'POST', signal,
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: file,
  });
  if (!up.ok) throw await apiError(up);
  let info = (await up.json()).file;
  while (info.state === 'PROCESSING') {
    onStatus?.('Gemini está procesando el vídeo…');
    await new Promise((r) => setTimeout(r, 2000));
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    const res = await fetch(`${API}/v1beta/${info.name}`, { headers: headers(), signal });
    if (!res.ok) throw await apiError(res);
    info = await res.json();
  }
  if (info.state === 'FAILED') throw new Error('Gemini no pudo procesar el vídeo.');
  return { uri: info.uri, mime };
}

/** Parte de vídeo para `input`, en línea si es pequeño o subido con la Files API si no. */
export async function videoPart(file, { fps, signal, onStatus }) {
  const processing = { type: 'static', fps };
  if (file.size <= INLINE_MAX) {
    return { type: 'video', data: await toBase64(file), mime_type: mimeOf(file), processing };
  }
  if (!uploads.has(file)) uploads.set(file, await uploadFile(file, signal, onStatus));
  const { uri, mime } = uploads.get(file);
  return { type: 'video', uri, mime_type: mime, processing };
}

/** Llama al modelo y devuelve el JSON que cumple `schema`. */
export async function interact({ model, input, schema, thinking = 'medium', maxTokens = 32768, signal }) {
  if (!apiKey) throw new Error('Falta la clave de la API de Gemini.');
  const res = await fetch(`${API}/v1beta/interactions`, {
    method: 'POST', signal,
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model,
      input,
      response_format: { type: 'text', mime_type: 'application/json', schema },
      generation_config: { thinking_level: thinking, max_output_tokens: maxTokens },
    }),
  });
  if (!res.ok) throw await apiError(res);
  const data = await res.json();
  const text = data.output_text ?? (data.steps || [])
    .filter((s) => !s.type || s.type === 'model_output')
    .flatMap((s) => s.content || [])
    .map((c) => c.text || '')
    .join('');
  if (!text) throw new Error('La respuesta de Gemini llegó vacía.');
  try {
    return { json: JSON.parse(text), usage: data.usage ?? null };
  } catch {
    throw new Error('Gemini no devolvió un JSON válido.');
  }
}
