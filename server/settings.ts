import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './config.js';
import type { Settings } from '../shared/types.js';

const FILE = path.join(APP_DIR, 'settings.json');

const DEFAULTS: Settings = {
  claudeArgs: ['--dangerously-skip-permissions'],
  codexArgs: [],
  showImported: false,
  extraProjectDirs: [],
};

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Partial<Settings>): Settings {
  const merged = { ...loadSettings(), ...s };
  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2));
  return merged;
}
