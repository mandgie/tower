import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import QRCode from 'qrcode';
import { APP_DIR } from './config.js';
import type { RemoteInfo, RemoteUrl, Settings } from '../shared/types.js';

/**
 * Remote access: a second listener, separate from the loopback one the Electron window uses, that a
 * phone or iPad reaches over Tailscale (or the LAN when allowed). Every request on it needs the pairing
 * token, which a device receives once by scanning the QR code in Settings and then keeps in a cookie.
 */

const TOKEN_FILE = path.join(APP_DIR, 'remote-token');
const COOKIE = 'tower_token';

let token = '';

function readToken(): string {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch { /* first run */ }
  return rotateToken();
}

/** Replaces the token, which unpairs every device. */
export function rotateToken(): string {
  const t = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  token = t;
  return t;
}

token = readToken();

function sameToken(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieToken(req: http.IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function isPaired(req: http.IncomingMessage): boolean {
  return sameToken(cookieToken(req));
}

// ---- who may connect -------------------------------------------------------------------------

function ipv4(addr: string): number[] | null {
  const m = addr.replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return m ? m.slice(1).map(Number) : null;
}

export function isLoopback(addr: string): boolean {
  const v4 = ipv4(addr);
  return v4 ? v4[0] === 127 : addr === '::1';
}

/** Tailscale hands out 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
function isTailscale(addr: string): boolean {
  const v4 = ipv4(addr);
  if (v4) return v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127;
  return addr.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

function isPrivateLan(addr: string): boolean {
  const v4 = ipv4(addr);
  if (v4) return v4[0] === 10 || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] === 192 && v4[1] === 168);
  const a = addr.toLowerCase();
  return a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd');
}

/** Loopback covers `tailscale serve`, which proxies HTTPS to this port from the Mac itself. */
export function peerAllowed(addr: string | undefined, allowLan: boolean): boolean {
  if (!addr) return false;
  return isLoopback(addr) || isTailscale(addr) || (allowLan && isPrivateLan(addr));
}

/** A browser request from another site carries a foreign Origin; refuse it so pages cannot drive tmux. */
export function originMatchesHost(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// ---- pairing ---------------------------------------------------------------------------------

/** `/pair?t=…` stores the token in a cookie and sends the device to the app. */
export function handlePair(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (!sameToken(url.searchParams.get('t') || undefined)) return unpairedPage(res);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.writeHead(302, {
    'set-cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
    location: '/',
    'cache-control': 'no-store',
  });
  res.end();
}

export function unpairedPage(res: http.ServerResponse): void {
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tower</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;background:#0d1114;color:#d7dde2;display:grid;place-items:center;min-height:100vh;margin:0;padding:0 16px}
main{max-width:360px}h1{font-size:20px}p{color:#8b96a0;line-height:1.5}</style>
<main><h1>This device is not paired</h1><p>On your Mac, open Tower → Settings → Remote access and scan the QR code with this device's camera.</p></main>`);
}

// ---- the listener ----------------------------------------------------------------------------

let remoteServer: http.Server | null = null;
let listeningOn = 0;
let lastError = '';

/** Starts, restarts or stops the remote listener to match settings. */
export function applyRemote(settings: Settings, server: () => http.Server): Promise<void> {
  const want = settings.remoteEnabled ? settings.remotePort : 0;
  if (remoteServer && listeningOn === want) return Promise.resolve();
  return new Promise((resolve) => {
    const start = () => {
      remoteServer = null; listeningOn = 0; lastError = '';
      if (!want) return resolve();
      const s = server();
      s.once('error', (e: NodeJS.ErrnoException) => {
        lastError = e.code === 'EADDRINUSE' ? `Port ${want} is in use by another program` : e.message;
        console.error('[remote] listen failed', e.message);
        resolve();
      });
      // '::' is dual-stack on macOS; peers are filtered per connection, see peerAllowed.
      s.listen(want, '::', () => {
        remoteServer = s; listeningOn = want;
        console.log(`[remote] listening on port ${want}`);
        resolve();
      });
    };
    if (remoteServer) {
      const old = remoteServer;
      old.close(() => start());
      old.closeAllConnections();
    } else start();
  });
}

// ---- what to show in Settings ----------------------------------------------------------------

let dnsCache: { at: number; name: string } = { at: 0, name: '' };

/** The Mac's MagicDNS name from the Tailscale CLI, if Tailscale is installed. */
function tailscaleName(): Promise<string> {
  if (Date.now() - dnsCache.at < 60_000) return Promise.resolve(dnsCache.name);
  const bins = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
  const bin = bins.find((b) => fs.existsSync(b));
  if (!bin) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile(bin, ['status', '--json'], { timeout: 3000 }, (err, stdout) => {
      let name = '';
      if (!err) { try { name = String(JSON.parse(stdout).Self?.DNSName || '').replace(/\.$/, ''); } catch { /* ignore */ } }
      dnsCache = { at: Date.now(), name };
      resolve(name);
    });
  });
}

export async function remoteInfo(settings: Settings, connected: number): Promise<RemoteInfo> {
  const port = settings.remotePort;
  const urls: RemoteUrl[] = [];
  const dns = await tailscaleName();
  if (dns) urls.push({ kind: 'tailscale', label: dns, url: `http://${dns}:${port}`, pairUrl: '', qrSvg: '' });
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal || a.family !== 'IPv4') continue;
      if (isTailscale(a.address)) urls.push({ kind: 'tailscale', label: a.address, url: `http://${a.address}:${port}`, pairUrl: '', qrSvg: '' });
      else if (settings.remoteAllowLan && isPrivateLan(a.address)) urls.push({ kind: 'lan', label: a.address, url: `http://${a.address}:${port}`, pairUrl: '', qrSvg: '' });
    }
  }
  for (const u of urls) {
    u.pairUrl = `${u.url}/pair?t=${token}`;
    u.qrSvg = await QRCode.toString(u.pairUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  }
  return {
    enabled: settings.remoteEnabled,
    listening: listeningOn > 0,
    port,
    error: lastError,
    tailscale: urls.some((u) => u.kind === 'tailscale'),
    urls,
    connected,
  };
}
