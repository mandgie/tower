import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_DIR } from './config.js';

/**
 * Pictures sent from the phone. The Mac keeps them on disk and the agent gets the path, the same way a
 * file dropped on a desktop terminal arrives: Claude Code and Codex turn a pasted image path into an
 * attachment. Old ones are removed after a week.
 */
const DIR = path.join(APP_DIR, 'uploads');
const MAX_BYTES = 25 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif',
};

const run = promisify(execFile);

export async function saveUpload(req: http.IncomingMessage): Promise<string> {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = EXT[type];
  if (!ext) throw new Error('Only images can be attached (PNG, JPEG, GIF, WebP or HEIC).');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BYTES) throw new Error('That image is over 25 MB.');
    chunks.push(c as Buffer);
  }
  if (!size) throw new Error('Empty upload');
  fs.mkdirSync(DIR, { recursive: true });
  prune();
  const base = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  let file = path.join(DIR, base + ext);
  fs.writeFileSync(file, Buffer.concat(chunks));
  // The agents read PNG, JPEG, GIF and WebP; an iPhone photo can arrive as HEIC, which sips converts.
  if (ext === '.heic' || ext === '.heif') {
    const jpg = path.join(DIR, `${base}.jpg`);
    await run('sips', ['-s', 'format', 'jpeg', file, '--out', jpg]);
    fs.rmSync(file, { force: true });
    file = jpg;
  }
  return file;
}

/** `/api/uploads/<name>` for a picture still saved here, so the chat can show it; undefined for any other path. */
export function uploadUrl(p: string): string | undefined {
  return isUpload(p) ? `/api/uploads/${path.basename(p)}` : undefined;
}

export function uploadFile(name: string): { file: string; type: string } | null {
  const file = path.join(DIR, name);
  if (!isUpload(file)) return null;
  const ext = path.extname(name).toLowerCase();
  const type = Object.keys(EXT).find((t) => EXT[t] === ext) ?? 'application/octet-stream';
  return { file, type };
}

/** Only files saved here may be sent along with a message. */
export function isUpload(p: unknown): p is string {
  return typeof p === 'string' && path.dirname(p) === DIR && /^[\w.-]+$/.test(path.basename(p)) && fs.existsSync(p);
}

function prune(): void {
  const cutoff = Date.now() - KEEP_MS;
  for (const f of fs.readdirSync(DIR)) {
    const p = path.join(DIR, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch { /* gone */ }
  }
}
