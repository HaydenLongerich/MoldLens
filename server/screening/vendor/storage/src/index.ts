import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// Relative STORAGE_ROOT values resolve against the repository root, so web, worker and scripts agree.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Private object storage (PLAN §4, §9). There is no public bucket: every read goes
 * through an authorization check that issues a short-lived signed token.
 * The local driver is for development; an S3-compatible driver implements the same interface.
 */
export interface ObjectStore {
  putBuffer(key: string, data: Buffer, contentType?: string): Promise<void>;
  putFile(key: string, sourcePath: string): Promise<void>;
  /** Write bytes at an offset (resumable chunked upload). */
  writeAt(key: string, offset: number, data: Buffer): Promise<number>;
  size(key: string): Promise<number | null>;
  readStream(key: string, range?: { start: number; end: number }): Readable;
  readBuffer(key: string): Promise<Buffer>;
  /** Absolute local path for tools like ffmpeg (download-to-temp for remote drivers). */
  localPath(key: string): Promise<string>;
  move(fromKey: string, toKey: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,400}$/i;

export function assertSafeKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error("Invalid object key");
  }
}

export class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private abs(key: string): string {
    assertSafeKey(key);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid object key");
    return p;
  }

  async putBuffer(key: string, data: Buffer): Promise<void> {
    const p = this.abs(key);
    await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    await fs.writeFile(p, data, { mode: 0o600 });
  }

  async putFile(key: string, sourcePath: string): Promise<void> {
    const p = this.abs(key);
    await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    await pipeline(createReadStream(sourcePath), createWriteStream(p, { mode: 0o600 }));
  }

  async writeAt(key: string, offset: number, data: Buffer): Promise<number> {
    const p = this.abs(key);
    await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    const fh = await fs.open(p, "r+").catch(async (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" && offset === 0) return fs.open(p, "wx", 0o600);
      throw e;
    });
    try {
      const st = await fh.stat();
      if (st.size < offset) throw new Error(`Offset mismatch: expected ${st.size}, got ${offset}`);
      // The DB offset is canonical; trim an uncommitted tail from a crashed write.
      // Callers hold the upload/assessment lock before entering this function.
      if (st.size > offset) await fh.truncate(offset);
      let written = 0;
      while (written < data.length) {
        const result = await fh.write(data, written, data.length - written, offset + written);
        if (result.bytesWritten === 0) throw new Error("Upload write made no progress");
        written += result.bytesWritten;
      }
      await fh.sync();
      return offset + data.length;
    } finally {
      await fh.close();
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await fs.stat(this.abs(key))).size;
    } catch {
      return null;
    }
  }

  readStream(key: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.abs(key), range ? { start: range.start, end: range.end } : undefined);
  }

  readBuffer(key: string): Promise<Buffer> {
    return fs.readFile(this.abs(key));
  }

  async localPath(key: string): Promise<string> {
    return this.abs(key);
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    const to = this.abs(toKey);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(this.abs(fromKey), to);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.abs(key), { force: true });
  }
}

const g = globalThis as unknown as { __mbStore?: ObjectStore };
export function getStore(): ObjectStore {
  if (!g.__mbStore) {
    const driver = process.env.STORAGE_DRIVER ?? "local";
    if (driver !== "local") throw new Error(`Storage driver '${driver}' not implemented yet (S3 adapter is a Phase 5 task)`);
    g.__mbStore = new LocalObjectStore(path.resolve(REPO_ROOT, process.env.STORAGE_ROOT ?? ".data/storage"));
  }
  return g.__mbStore;
}
export function setStore(s: ObjectStore) {
  g.__mbStore = s;
}

// ---------------------------------------------------------------------------
// Signed, short-lived access tokens. Issued only after a server-side authorization check.

export interface SignedAccess {
  key: string;
  /** Unix ms expiry. */
  exp: number;
  contentType: string;
  /** Who it was issued to (audit only). */
  sub: string;
}

function secret(): string {
  const s = process.env.STORAGE_SIGNING_SECRET;
  if (!s || s.length < 32) throw new Error("STORAGE_SIGNING_SECRET must be set (>= 32 chars)");
  return s;
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

export function signAccess(a: Omit<SignedAccess, "exp">, ttlMs = 5 * 60_000): string {
  const payload = b64(JSON.stringify({ ...a, exp: Date.now() + ttlMs }));
  const mac = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyAccess(token: string, now = Date.now()): SignedAccess | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", secret()).update(payload).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const a = JSON.parse(Buffer.from(payload, "base64url").toString()) as SignedAccess;
    if (typeof a.exp !== "number" || a.exp < now) return null;
    assertSafeKey(a.key);
    return a;
  } catch {
    return null;
  }
}

export function signedMediaUrl(a: Omit<SignedAccess, "exp">, ttlMs?: number): string {
  return `/api/media/${signAccess(a, ttlMs)}`;
}
