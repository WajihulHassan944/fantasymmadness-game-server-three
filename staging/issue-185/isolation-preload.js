'use strict';

// Issue #185 isolated staging harness (test-only; never loaded in production).
// Loaded with `node -r ./staging/issue-185/isolation-preload.js full-card-bootstrap.js`.
//
// 1. Refuses to start unless STAGING_ISOLATED=1 and the database is local.
// 2. Blocks every outbound network connection except loopback, so the server
//    cannot reach the live database, payment processor, email providers,
//    social platforms or the image library, whatever its code tries.
// 3. Replaces image-library uploads with a local folder served on loopback,
//    so poster uploads run through the real upload routes.

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

if (process.env.STAGING_ISOLATED !== '1') throw new Error('Refusing to start: STAGING_ISOLATED=1 is required.');
const mongoUri = String(process.env.MONGODB_URI || '');
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(mongoUri)) throw new Error('Refusing to start: MONGODB_URI must point at a local staging database.');
for (const name of ['RESEND_API_KEY', 'SENDGRID_API_KEY', 'BREVO_API_KEY', 'POSTMARK_SERVER_TOKEN', 'AUTHORIZE_NET_API_LOGIN_ID', 'AUTHORIZE_NET_TRANSACTION_KEY', 'CLOUDINARY_API_SECRET']) {
  if (process.env[name]) throw new Error(`Refusing to start: ${name} must not be set in isolated staging.`);
}

const outDir = path.resolve(process.env.STAGING_OUT_DIR || path.join(__dirname, 'out'));
fs.mkdirSync(outDir, { recursive: true });
const blockedLog = path.join(outDir, 'blocked-outbound.log');

// ---- Loopback-only networking ----------------------------------------------
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);
const hostOf = (args) => {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') {
    if (first.path) return 'unix-socket';
    return String(first.host || first.hostname || 'localhost');
  }
  if (typeof first === 'number' || /^\d+$/.test(String(first))) return typeof args[1] === 'string' ? args[1] : 'localhost';
  if (typeof first === 'string') return 'unix-socket';
  return 'localhost';
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function isolatedConnect(...args) {
  const host = hostOf(args).replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== 'unix-socket' && !LOOPBACK.has(host)) {
    fs.appendFileSync(blockedLog, `${new Date().toISOString()} ${host}\n`);
    const error = Object.assign(new Error(`Isolated staging: outbound connection to ${host} was blocked.`), { code: 'ECONNREFUSED' });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return originalConnect.apply(this, args);
};

// ---- Local image library ----------------------------------------------------
const MEDIA_PORT = Number(process.env.STAGING_MEDIA_PORT || 9187);
const mediaDir = path.join(outDir, 'media');
fs.mkdirSync(mediaDir, { recursive: true });
const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
http.createServer((req, res) => {
  const file = path.join(mediaDir, path.normalize(decodeURIComponent(String(req.url || '').split('?')[0])).replace(/^([/\\])+/, ''));
  if (!file.startsWith(mediaDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', types[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream');
  return fs.createReadStream(file).pipe(res);
}).listen(MEDIA_PORT, '127.0.0.1');

const sniff = (buffer) => (buffer[0] === 0x89 ? 'png' : buffer[0] === 0xff ? 'jpg' : buffer.slice(8, 12).toString() === 'WEBP' ? 'webp' : 'png');
const store = (buffer, options = {}) => {
  const folder = String(options.folder || 'misc').replace(/[^a-z0-9/_-]/gi, '_');
  const id = crypto.randomBytes(8).toString('hex');
  const ext = sniff(buffer);
  fs.mkdirSync(path.join(mediaDir, folder), { recursive: true });
  fs.writeFileSync(path.join(mediaDir, folder, `${id}.${ext}`), buffer);
  return { secure_url: `http://127.0.0.1:${MEDIA_PORT}/${folder}/${id}.${ext}`, public_id: `${folder}/${id}`, bytes: buffer.length, format: ext };
};
const cloudinary = require('cloudinary').v2;
const { Writable } = require('stream');
cloudinary.uploader.upload_stream = (options, callback) => {
  const chunks = [];
  return new Writable({
    write(chunk, _encoding, done) { chunks.push(chunk); done(); },
    final(done) { try { callback(null, store(Buffer.concat(chunks), options)); } catch (error) { callback(error); } done(); },
  });
};
cloudinary.uploader.upload = async (input, options = {}) => {
  const data = String(input || '');
  const match = data.match(/^data:image\/[a-z]+;base64,(.+)$/i);
  if (!match) throw new Error('Isolated staging only accepts data-URI uploads.');
  return store(Buffer.from(match[1], 'base64'), options);
};
cloudinary.uploader.destroy = async () => ({ result: 'ok' });

console.log(`[staging] isolation active: loopback-only network, local media on 127.0.0.1:${MEDIA_PORT}, output ${outDir}`);
