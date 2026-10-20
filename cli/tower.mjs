#!/usr/bin/env node
// tower: start and talk to other Claude sessions in Tower from inside a session.
// Tower copies this file to ~/.multisession/bin/tower and puts that folder on PATH in every session it starts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HELP = `tower: start and talk to other Claude sessions (agents) in Tower.

  tower spawn [options] "task"     Start a new Claude session with the task as its first prompt.
                                   Prints the agent's name. Use "-" as the task to read it from stdin.
      --name NAME                  Short name for the agent (default agent-1, agent-2, ...).
      --cwd DIR                    Folder to start in (default: this session's folder).
      --worktree                   Start in a new git worktree on its own branch.
      --model MODEL                Model for the agent (for example sonnet or opus).
      --wait                       Wait for its first answer and print it.
  tower send NAME "text"           Type a prompt into the agent. "-" reads the text from stdin.
                                   NAME "parent" is the session that started this one.
  tower wait NAME... [--any]       Wait until the agents finish their turn, then print their answers.
      --timeout 30m                Give up after this long (s, m or h; default 30m).
      --any                        Return when the first one finishes.
      --quiet                      Print only the state, not the answers.
  tower read NAME                  Print the agent's last answer.
  tower list [--all]               The agents this session started (--all: every agent).
  tower stop NAME...               Stop the agents (their worktrees stay).
  tower whoami                     This session's name, and its parent if it has one.

Agents are full Claude sessions with --dangerously-skip-permissions. They show in the parent's
workspace in Tower, and the user can watch them and type in them. An agent can spawn agents too.`;

function fail(msg, code = 1) { process.stderr.write(`tower: ${msg}\n`); process.exit(code); }

function baseUrl() {
  if (process.env.TOWER_URL) return process.env.TOWER_URL.replace(/\/$/, '');
  const dir = process.env.MS_APP_DIR || path.join(os.homedir(), '.multisession');
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8')).url; } catch { /* below */ }
  fail('cannot find Tower. Is the Tower app running?');
}

/** This session's tmux name, when it runs in a tmux pane. */
function me() {
  if (!process.env.TMUX || !process.env.TMUX_PANE) return '';
  try { return execFileSync('tmux', ['display-message', '-p', '-t', process.env.TMUX_PANE, '#S'], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

async function api(method, p, body) {
  let res;
  try {
    res = await fetch(baseUrl() + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch { fail('cannot reach Tower. Is the Tower app running?'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) fail(j.error || `HTTP ${res.status}`);
  return j;
}

function parseArgs(argv, flags) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const [k, v] = a.slice(2).split('=', 2);
      if (!(k in flags)) fail(`unknown option --${k}. Run: tower help`);
      out[k] = flags[k] ? (v ?? argv[++i]) : true;
      if (flags[k] && out[k] === undefined) fail(`--${k} needs a value`);
    } else out._.push(a);
  }
  return out;
}

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }
function textArg(parts) {
  const t = parts.join(' ');
  return t === '-' || (!t && !process.stdin.isTTY) ? readStdin() : t;
}

function duration(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)([smh]?)$/);
  if (!m) fail(`bad duration ${s}; use for example 90s, 30m or 2h`);
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600 }[m[2]] * 1000;
}

const q = (o) => '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString();

function show(v, withReply) {
  const extra = [v.session && `session ${v.session}`, v.worktree && `branch ${v.worktree.branch}`].filter(Boolean).join(' · ');
  let out = `== ${v.name} (${v.state})${extra ? ' · ' + extra : ''}`;
  if (withReply) {
    if (v.question) out += `\nIt asks a question and waits for an answer (answer with tower send ${v.name} "..."):\n${v.question}`;
    else if (v.reply) out += `\n${v.reply}`;
    else out += '\n(no answer yet)';
  }
  return out;
}

async function wait(names, o) {
  const from = me();
  const timeout = duration(o.timeout ?? '30m');
  const end = Date.now() + timeout;
  const done = new Map();
  for (;;) {
    for (const n of names) {
      if (done.has(n)) continue;
      const v = await api('GET', '/api/agents/state' + q({ from, ref: n, reply: '1' }));
      if (v.state !== 'working') { done.set(n, v); console.log(show(v, !o.quiet) + '\n'); }
    }
    if (done.size === names.length || (o.any && done.size)) return 0;
    if (Date.now() > end) {
      console.log(`Timed out after ${o.timeout ?? '30m'}. Still working: ${names.filter((n) => !done.has(n)).join(', ')}`);
      return 2;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const from = me();
  switch (cmd) {
    case 'spawn': {
      const o = parseArgs(rest, { name: 1, cwd: 1, worktree: 0, model: 1, wait: 0, timeout: 1 });
      const task = textArg(o._).trim();
      if (!task) fail('give the agent a task: tower spawn "task"');
      const cwd = o.cwd ? path.resolve(o.cwd.replace(/^~(?=\/|$)/, os.homedir())) : (from ? undefined : process.cwd());
      const v = await api('POST', '/api/agents/spawn', { from, task, cwd, name: o.name, worktree: !!o.worktree, model: o.model });
      console.log(v.name);
      if (v.worktree) console.error(`worktree ${v.worktree.path} on branch ${v.worktree.branch}`);
      if (o.wait) process.exit(await wait([v.name], o));
      return;
    }
    case 'send': {
      const [name, ...text] = rest;
      if (!name) fail('tower send NAME "text"');
      const t = textArg(text);
      if (!t.trim()) fail('nothing to send');
      const v = await api('POST', '/api/agents/send', { from, ref: name, text: t });
      console.log(`sent to ${v.name}`);
      return;
    }
    case 'wait': {
      const o = parseArgs(rest, { timeout: 1, any: 0, quiet: 0 });
      if (!o._.length) fail('tower wait NAME...');
      process.exit(await wait(o._, o));
    }
    case 'read': {
      if (!rest[0]) fail('tower read NAME');
      console.log(show(await api('GET', '/api/agents/state' + q({ from, ref: rest[0], reply: '1' })), true));
      return;
    }
    case 'status': {
      if (!rest[0]) fail('tower status NAME');
      console.log(show(await api('GET', '/api/agents/state' + q({ from, ref: rest[0] })), false));
      return;
    }
    case 'list': case 'ls': {
      const o = parseArgs(rest, { all: 0 });
      const list = await api('GET', '/api/agents' + q({ from, all: o.all ? '1' : '' }));
      if (!list.length) { console.log(o.all ? 'No agents.' : 'This session has started no agents.'); return; }
      for (const v of list) console.log(show(v, false) + (v.title ? `\n   ${v.title}` : ''));
      return;
    }
    case 'stop': {
      if (!rest.length) fail('tower stop NAME...');
      for (const n of rest) { const v = await api('POST', '/api/agents/stop', { from, ref: n }); console.log(`stopped ${v.name}${v.worktree ? ` (worktree ${v.worktree.path} stays)` : ''}`); }
      return;
    }
    case 'whoami': {
      if (!from) { console.log('This shell is not in a Tower session.'); return; }
      console.log(`session ${from}`);
      const p = await fetch(baseUrl() + '/api/agents/state' + q({ from, ref: 'parent' })).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (p) console.log(`parent ${p.name} (${p.title ?? p.session})`);
      return;
    }
    case undefined: case 'help': case '-h': case '--help':
      console.log(HELP);
      return;
    default:
      fail(`unknown command ${cmd}. Run: tower help`);
  }
}

main();
