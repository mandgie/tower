/**
 * Addresses for things on another Tower server (a host, server/hosts.ts). This server shows a host's
 * sessions as its own, with `@<host>:` in front of every name the UI hands back: tmux names, session keys
 * and ids, and folders. tmux does not allow `:` in a session name, so an address never collides with a
 * local tmux name, and the server can tell from the name alone where a request goes.
 */

const ADDR = /^@([a-z0-9][a-z0-9-]{0,62}):([\s\S]*)$/;

export function onHost(host: string, name: string): string {
  return `@${host}:${name}`;
}

/** The host and the name on that host, or null for a local name. */
export function splitHost(addr: string): { host: string; name: string } | null {
  const m = ADDR.exec(addr);
  return m ? { host: m[1], name: m[2] } : null;
}

/** A host name: lowercase letters, digits and dashes, as in a MagicDNS name. */
export function validHostName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(name);
}

/** `@tower-1:/home/magnus/repos/x` reads as `tower-1:~/repos/x`. */
export function displayAddr(addr: string): string {
  const h = splitHost(addr);
  const tidy = (p: string) => p.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~');
  return h ? `${h.host}:${tidy(h.name)}` : tidy(addr);
}
