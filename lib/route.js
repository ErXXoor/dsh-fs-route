/**
 * Route parsing and classification for dsh-fs-route.
 *
 * A "route" is the pair (provider kind, execution-world path). Sessions name
 * their working directory with one of:
 *
 *   - `ssh://<alias>/<abs path>`  — explicit remote route
 *   - a LOCAL PLACEHOLDER path    — a real absolute host path that stands in
 *     for a remote directory (see {@link placeholderPath}); the workspace
 *     controller validates a workspace path with `path.isAbsolute`, and on
 *     Windows `ssh://…` is NOT absolute (no drive letter), so the picked path
 *     handed to `createWorkspace` must be host-shaped. Both providers translate
 *     the placeholder back into the SSH route.
 *   - a local absolute path       — stays on the local provider
 *   - a relative path             — resolved against the session cwd first
 *
 * The route is encoded into the opaque `FsTargetKey` so every later operation
 * can recover the backend without re-deriving it from a path.
 *
 * @module dsh-fs-route/route
 */
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Separator between the route id and the path inside an encoded target key. */
const KEY_SEP = '\u0000';

/** Last path segment of the placeholder root, used to recognise one. */
const ROUTE_DIR = 'dsh-fs-route-workspaces';

/**
 * Root of the local placeholder tree standing in for remote workspaces.
 * @returns {string} absolute host directory.
 */
export function routeRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return resolve(home, ROUTE_DIR);
}

/**
 * The local placeholder path for one remote directory. Host-shaped, so it is
 * absolute on every platform, and unambiguous, because the first segment under
 * the root is the alias.
 * @param {string} alias - route alias.
 * @param {string} remotePath - absolute POSIX path on the remote host.
 * @returns {string} the local placeholder path.
 */
export function placeholderPath(alias, remotePath) {
  const segments = remotePath.split('/').filter((segment) => segment !== '');
  return join(routeRoot(), alias, ...segments);
}

/**
 * Recognise a placeholder path and recover its route.
 *
 * `isKnownAlias` matters: project-root discovery walks UP from the session cwd
 * (looking for `.git`, `AGENTS.md`, …), so it eventually probes
 * `<root>/.git`, whose first segment after the root is `.git` — a syntactically
 * valid alias name. Without the predicate that probe becomes a bogus
 * `ssh://.git/…` route and fails the whole turn. Callers pass their registry's
 * membership test so only configured aliases are treated as routes; everything
 * else stays an ordinary local path.
 * @param {string} value - candidate host path.
 * @param {(alias: string) => boolean} [isKnownAlias] - alias membership test.
 * @returns {{alias: string, path: string} | null} the route, or null.
 */
export function parsePlaceholder(value, isKnownAlias) {
  if (typeof value !== 'string') return null;
  if (!value.toLowerCase().includes(ROUTE_DIR)) return null;
  const root = routeRoot();
  const rel = relative(root, resolve(value));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  const segments = rel.split(/[\\/]+/).filter((segment) => segment !== '');
  const alias = segments[0];
  if (alias === undefined || !/^[A-Za-z0-9._-]+$/.test(alias)) return null;
  if (isKnownAlias !== undefined && !isKnownAlias(alias)) return null;
  const rest = segments.slice(1);
  return { alias, path: rest.length === 0 ? '/' : `/${rest.join('/')}` };
}

/**
 * Parse an `ssh://<alias>/<abs>` route.
 * @param {string} value - candidate route string.
 * @returns {{alias: string, path: string} | null} parsed route, or null when the value is not an ssh route.
 */
export function parseSshRoute(value) {
  if (typeof value !== 'string' || !value.startsWith('ssh://')) return null;
  const rest = value.slice('ssh://'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const alias = rest.slice(0, slash);
  const path = rest.slice(slash);
  if (alias === '' || !path.startsWith('/')) return null;
  return { alias, path };
}

/**
 * Parse any spelling that names a route: `ssh://…`, a local placeholder, or a
 * route displaced into the middle of a joined host path (a Windows
 * `path.isAbsolute('ssh://…')` is false, so the tool layer can prefix a session
 * cwd to it).
 * @param {string | undefined} value - candidate.
 * @param {(alias: string) => boolean} [isKnownAlias] - alias membership test for placeholder spellings.
 * @returns {{alias: string, path: string} | null} the route, or null for local paths.
 */
export function parseAnyRoute(value, isKnownAlias) {
  if (typeof value !== 'string') return null;
  const direct = parseSshRoute(value);
  if (direct !== null) return direct;
  const placeholder = parsePlaceholder(value, isKnownAlias);
  if (placeholder !== null) return placeholder;
  const at = value.indexOf('ssh://');
  if (at > 0) return parseSshRoute(value.slice(at));
  return null;
}

export { sep, ROUTE_DIR };


/**
 * Whether a raw path names a remote route.
 * @param {string} value - candidate path.
 * @returns {boolean} true when the value is an `ssh://` route.
 */
export function isSshRoute(value) {
  return parseSshRoute(value) !== null;
}

/**
 * Whether a path is meaningful in a POSIX execution world.
 * @param {string} value - candidate path.
 * @returns {boolean} true for POSIX-absolute paths.
 */
export function isPosixAbsolute(value) {
  return typeof value === 'string' && value.startsWith('/');
}

/**
 * Whether a path is a Windows host path (drive letter or UNC), and therefore
 * has no meaning on a remote POSIX host.
 * @param {string} value - candidate path.
 * @returns {boolean} true for Windows-shaped absolute paths.
 */
export function isWindowsAbsolute(value) {
  return typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//'));
}

/**
 * Join a POSIX base with a relative POSIX path, collapsing `.` and `..`
 * without touching the host filesystem.
 * @param {string} base - absolute POSIX directory.
 * @param {string} relative - relative path to append.
 * @returns {string} the resolved absolute POSIX path.
 */
export function posixJoin(base, relative) {
  const segments = (base + '/' + relative).split('/');
  const out = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return '/' + out.join('/');
}

/**
 * Encode a route into an opaque target key.
 * @param {string | undefined} alias - remote alias, or undefined for the local provider.
 * @param {string} path - canonical path in that execution world.
 * @returns {string} the encoded key.
 */
export function encodeKey(alias, path) {
  return (alias === undefined ? '' : alias) + KEY_SEP + path;
}

/**
 * Decode an opaque target key produced by {@link encodeKey}.
 * @param {string} key - the encoded key.
 * @returns {{alias: string | undefined, path: string}} the route and path.
 */
export function decodeKey(key) {
  const at = key.indexOf(KEY_SEP);
  if (at < 0) return { alias: undefined, path: key };
  const alias = key.slice(0, at);
  return { alias: alias === '' ? undefined : alias, path: key.slice(at + 1) };
}
