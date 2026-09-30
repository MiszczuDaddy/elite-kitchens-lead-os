// WhatsApp media: download inbound files from the official Cloud API into private Cloud Storage,
// validate outbound files against WhatsApp's limits, and mint short-lived signed URLs for staff.
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { HttpsError } = require('firebase-functions/v2/https');

const MB = 1024 * 1024;
const MAX_INBOUND = 100 * MB;

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'application/pdf': 'pdf',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'text/plain': 'txt' };

const baseMime = (m) => String(m || '').toLowerCase().split(';')[0].trim();

// A storage-safe file name: no path separators or odd characters, bounded length, always has an extension if we can tell.
function safeName(name, mime, fallback = 'file') {
  let n = String(name || '').split(/[\\/]/).pop().replace(/[^\w.\- ()\u00C0-\u024F]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!n) n = fallback;
  if (n.length > 120) { const dot = n.lastIndexOf('.'); const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : ''; n = n.slice(0, 120 - ext.length) + ext; }
  if (!/\.[A-Za-z0-9]{1,8}$/.test(n) && EXT[baseMime(mime)]) n += '.' + EXT[baseMime(mime)];
  return n;
}

// What WhatsApp Cloud API accepts when SENDING (receiving accepts more).
const SEND_RULES = {
  image: { mimes: ['image/jpeg', 'image/png'], max: 5 * MB, label: 'Images must be JPG or PNG and under 5 MB' },
  video: { mimes: ['video/mp4', 'video/3gpp'], max: 16 * MB, label: 'Videos must be MP4 and under 16 MB' },
  audio: { mimes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'], max: 16 * MB, label: 'Audio must be under 16 MB' },
  document: { mimes: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain'], max: 100 * MB, label: 'Documents must be under 100 MB' },
};
function classifyForSend(mime, size) {
  const m = baseMime(mime);
  for (const [kind, r] of Object.entries(SEND_RULES)) {
    if (!r.mimes.includes(m)) continue;
    if (size > r.max) throw new HttpsError('invalid-argument', `That file is too large. ${r.label}.`);
    return kind;
  }
  throw new HttpsError('invalid-argument', "WhatsApp can't send that file type. Use JPG/PNG images, MP4 video, audio, or PDF/Word/Excel/PowerPoint/text documents.");
}

const objectPath = (phone, msgId, filename) => `media/${phone}/${msgId}/${filename}`;

// Download one inbound media item (by WhatsApp media id) into Storage. Never throws: returns {status, ...}.
async function downloadInbound({ wa, bucket, phone, msgId, media, timeoutMs = 20000 }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let file = null;
  try {
    const id = media.waMediaId || media.id;
    if (!id) return { status: 'failed', error: 'No media id on this message' };
    const info = await wa.getMediaInfo(id, ac.signal);                      // { url, mime_type, sha256, file_size }
    if (!info.url) return { status: 'failed', error: 'WhatsApp returned no download link (the file may have expired)' };
    if (Number(info.file_size) > MAX_INBOUND) return { status: 'failed', error: 'File is too large to store (over 100 MB)' };
    const mime = baseMime(info.mime_type || media.mimeType || media.mime_type) || 'application/octet-stream';
    const filename = safeName(media.filename, mime, `file-${String(msgId).replace(/[^A-Za-z0-9]/g, '').slice(-10) || 'x'}`);
    const res = await wa.fetchMedia(info.url, ac.signal);
    const path = objectPath(phone, msgId, filename);
    file = bucket.file(path);
    const hash = crypto.createHash('sha256'); let size = 0;
    const meter = new Transform({ transform(chunk, _e, cb) {
      size += chunk.length; hash.update(chunk);
      if (size > MAX_INBOUND) return cb(new Error('File is too large to store (over 100 MB)'));
      cb(null, chunk);
    } });
    await pipeline(Readable.fromWeb(res.body), meter, file.createWriteStream({ resumable: false, contentType: mime, metadata: { cacheControl: 'private, max-age=0' } }), { signal: ac.signal });
    return { status: 'stored', storagePath: path, size, mimeType: mime, sha256: hash.digest('hex'), filename, error: null };
  } catch (e) {
    if (file) await file.delete({ ignoreNotFound: true }).catch(() => {});   // never leave a partial file behind
    return { status: 'failed', error: ac.signal.aborted ? 'Timed out downloading from WhatsApp' : String(e.message || e).slice(0, 300) };
  } finally { clearTimeout(timer); }
}

// Short-lived link for staff to view/download a stored file. In the local emulator (no signing credentials)
// the bytes are returned as a data: URL so the same code path can be tested end to end.
async function signedUrl(bucket, path, { filename, mime, download = false, ttlMs = 10 * 60 * 1000 }) {
  const file = bucket.file(path);
  if (process.env.FUNCTIONS_EMULATOR === 'true' || process.env.STORAGE_EMULATOR_HOST) {
    const [buf] = await file.download();
    return `data:${mime || 'application/octet-stream'};base64,${buf.toString('base64')}`;
  }
  const ascii = String(filename || 'file').replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + ttlMs,
    responseType: mime || undefined,
    responseDisposition: download ? `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename || 'file')}` : 'inline' });
  return url;
}

module.exports = { safeName, classifyForSend, downloadInbound, signedUrl, objectPath, baseMime, SEND_RULES, MAX_INBOUND };
