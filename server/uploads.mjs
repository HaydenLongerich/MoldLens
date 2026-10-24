import Busboy from 'busboy';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './validation.mjs';

export const MAX_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_FILES = 10;
const formats = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
};

// Confirm media container signatures rather than trusting the client's MIME or extension.
export function detectMedia(buffer) {
  if (buffer.length >= 12 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 16 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const major = buffer.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(major)) return 'image/heic';
    if (['mif1', 'msf1'].includes(major)) return 'image/heif';
    if (major === 'qt  ') return 'video/quicktime';
    if (['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VH', 'M4VP', 'MSNV', 'dash', 'cmfc', 'cmfs'].includes(major)) return 'video/mp4';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && buffer.includes(Buffer.from('webm'))) return 'video/webm';
  return null;
}

function displayName(name) {
  return path.basename(name.replaceAll('\\', '/')).replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 180) || 'Uploaded media';
}

export async function receiveUploads(request, uploadDirectory) {
  await mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
  if (!request.headers['content-type']?.startsWith('multipart/form-data')) throw new HttpError(415, 'Please submit the inspection as multipart form data.');
  let parser;
  // Busboy emits `limit` when the boundary is reached, so reserve one extra byte
  // to accept files exactly at the advertised maximum and reject anything larger.
  try { parser = Busboy({ headers: request.headers, limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE + 1, fields: 1, fieldSize: 24 * 1024, parts: MAX_FILES + 1 } }); }
  catch { throw new HttpError(400, 'The upload could not be read. Please try again.'); }
  const jobs = [];
  const cleanupPaths = new Set();
  const attachments = [];
  let rawData;
  let failure;
  const fail = (error) => { failure ??= error; };
  const cleanup = async () => { await Promise.all([...cleanupPaths].map((filename) => unlink(filename).catch(() => {}))); };
  parser.on('field', (name, value, info) => {
    if (name !== 'data' || rawData !== undefined || info.valueTruncated) fail(new HttpError(400, 'Please provide one valid inspection data field.'));
    else rawData = value;
  });
  parser.on('fieldsLimit', () => fail(new HttpError(400, 'Only the inspection data field is accepted.')));
  parser.on('filesLimit', () => fail(new HttpError(400, 'You can upload up to 10 files.')));
  parser.on('partsLimit', () => fail(new HttpError(400, 'You can upload up to 10 files with your request.')));
  parser.on('file', (field, stream, info) => {
    if (field !== 'files' || !formats[info.mimeType]) {
      fail(new HttpError(415, 'Please use JPG, PNG, WebP, HEIC, HEIF, MP4, MOV, or WebM files.'));
      stream.resume(); return;
    }
    const id = randomUUID();
    const temporary = path.join(uploadDirectory, `.pending-${id}`);
    cleanupPaths.add(temporary);
    let size = 0;
    let prefix = Buffer.alloc(0);
    let oversized = false;
    stream.on('limit', () => { oversized = true; fail(new HttpError(413, 'Each file must be 25 MB or smaller.')); });
    const inspect = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk.subarray(0, 4096 - prefix.length)]);
      callback(null, chunk);
    } });
    jobs.push(pipeline(stream, inspect, createWriteStream(temporary, { flags: 'wx', mode: 0o600 })).then(async () => {
      if (oversized) return;
      const detected = detectMedia(prefix);
      const heifPair = ['image/heic', 'image/heif'].includes(detected) && ['image/heic', 'image/heif'].includes(info.mimeType);
      if (!detected || (!heifPair && detected !== info.mimeType)) { fail(new HttpError(415, 'One of your files does not match its media type. Please upload an original photo or video.')); return; }
      const filename = `${id}.${formats[detected]}`;
      const destination = path.join(uploadDirectory, filename);
      cleanupPaths.add(destination);
      await rename(temporary, destination);
      cleanupPaths.delete(temporary);
      attachments.push({ id, name: displayName(info.filename), type: detected, size, url: `/uploads/${filename}` });
    }).catch(() => { fail(new HttpError(400, 'A file could not be saved. Please try your upload again.')); }));
  });
  try {
    await new Promise((resolve, reject) => {
      const aborted = () => reject(new HttpError(400, 'The upload was interrupted.'));
      request.once('aborted', aborted);
      parser.once('close', () => { request.off('aborted', aborted); resolve(); });
      parser.once('error', () => { request.off('aborted', aborted); reject(new HttpError(400, 'The upload could not be read. Please try again.')); });
      request.pipe(parser);
    });
    await Promise.all(jobs);
    if (failure) throw failure;
    if (rawData === undefined) throw new HttpError(400, 'Please include your inspection details.');
    let data;
    try { data = JSON.parse(rawData); }
    catch { throw new HttpError(400, 'Your inspection details could not be read.'); }
    return { data, attachments, cleanup };
  } catch (error) {
    parser.destroy();
    await Promise.all(jobs);
    await cleanup();
    throw error;
  }
}
