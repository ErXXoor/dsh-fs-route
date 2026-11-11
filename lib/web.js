/**
 * Host half of the workspace picker: a small HTTP surface the client dialog
 * calls to browse an SSH host's directories.
 *
 * Registered under `/api/` so the page's same-origin fetch passes the shared
 * API trust fence; the route itself does no authentication beyond that fence
 * because it exposes only directory names on hosts the operator configured.
 *
 * @module dsh-fs-route/web
 */
import z from '@deepseek-ai/schemastery';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/api/dsh-fs-route';

/**
 * Required host services. `webServer` carries the route registry; the registry
 * and its connections live in the plugin's own module scope.
 */
export const inject = ['webServer'];

/** Channel configuration. */
export const Config = z.object({
  /** Alias registry shared with the providers. */
  hosts: z.any().default({}),
});

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} limit - byte cap.
 * @returns {Promise<object | null>} parsed object, or null when unusable.
 */
function readJson(req, limit = 1 << 20) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(typeof value === 'object' && value !== null ? value : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * Send a JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serialisable payload.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * POSIX-normalise one remote path without touching a filesystem.
 * @param {string} base - absolute POSIX base.
 * @param {string} relative - candidate segment or absolute path.
 * @returns {string} absolute POSIX path.
 */
function posixResolve(base, relative) {
  if (relative.startsWith('/')) {
    const segments = relative.split('/');
    const out = [];
    for (const s of segments) {
      if (s === '' || s === '.') continue;
      if (s === '..') { out.pop(); continue; }
      out.push(s);
    }
    return '/' + out.join('/');
  }
  const segments = (base + '/' + relative).split('/');
  const out = [];
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') { out.pop(); continue; }
    out.push(s);
  }
  return '/' + out.join('/');
}

/**
 * Register the browse routes.
 *
 * Every request passes the connection service's admission fence first: that is
 * the same check guarding the shared `/api` bridge, so only an authenticated
 * browser session reaches these listings. Without it a plain loopback process
 * could enumerate hosts and remote directories, and even trigger a remote
 * `mkdir`, with no credential at all (measured: 200 on this route while an
 * unknown `/api` path returned 401).
 *
 * The route is registered only when that fence is available: serving it
 * unauthenticated is never an acceptable fallback.
 * @param {import('@deepseek-ai/cordis').Context} ctx - mounting context.
 * @param {object} config - plugin configuration carrying the alias registry.
 * @param {import('./ssh.js').SshRegistry} registry - the shared alias registry.
 */
export function registerWorkspaceRoutes(ctx, config, registry) {
  /**
   * The service guarding the shared `/api` bridge. Resolved per request: this
   * route is registered from a `webServer` injection callback, which can run
   * before the connection service has activated, and `ctx.get` does not wait.
   * @returns {{requestRejection?: Function} | undefined} the connection service.
   */
  const connectionOf = () => ctx.get?.('connection');

  /**
   * Ensure the alias exists and answer its home + default directory.
   * @param {string} alias - route alias.
   * @returns {{alias: string, home: string, cwd: string, endpoint: string}} host facts.
   */
  const describe = (alias) => {
    const connection = registry.get(alias);
    return { alias, cwd: connection.cwd, endpoint: connection.endpoint };
  };

  const handler = async (req, res) => {
    // Admission first: the Host/Origin fence plus browser-cookie (or API-token)
    // authentication, identical to the shared `/api` bridge. A composition that
    // exposes no admission fence gets NO listings — fail closed, never open.
    const connection = connectionOf();
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
      res.end('unauthorized');
      return;
    }
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const action = url.pathname.slice(ROUTE_PREFIX.length + 1);

    try {
      if (req.method === 'GET' && action === 'hosts') {
        sendJson(res, 200, {
          hosts: registry.aliases.map((alias) => describe(alias)),
        });
        return;
      }

      if (req.method === 'POST' && action === 'list') {
        const body = await readJson(req);
        if (body === null) { sendJson(res, 400, { code: 'bad-request', message: 'invalid JSON body' }); return; }
        const alias = String(body.alias ?? '');
        const path = String(body.path ?? '');
        if (alias === '') { sendJson(res, 400, { code: 'bad-request', message: 'alias is required' }); return; }

        const connection = registry.get(alias);
        const target = posixResolve(connection.cwd, path === '' ? '.' : path);
        const sftp = await connection.sftp();
        const entries = await new Promise((resolve, reject) => {
          sftp.readdir(target, (error, list) => (error ? reject(error) : resolve(list)));
        });
        const home = (await connection.exec('printf %s "$HOME"')).stdout.trim();

        sendJson(res, 200, {
          alias,
          path: target,
          home,
          parent: target === '/' ? null : target.slice(0, target.lastIndexOf('/')) || '/',
          entries: entries
            .filter((e) => e.filename !== '.' && e.filename !== '..')
            .map((e) => ({
              name: e.filename,
              directory: e.attrs.isDirectory(),
              path: target === '/' ? `/${e.filename}` : `${target}/${e.filename}`,
            }))
            .sort((a, b) => (a.directory === b.directory ? (a.name < b.name ? -1 : 1) : a.directory ? -1 : 1)),
        });
        return;
      }

      if (req.method === 'POST' && action === 'route') {
        // The workspace controller validates a picked path with
        // `path.isAbsolute`, and on Windows `ssh://…` is not absolute (no
        // drive letter), so it rejects the route outright. Answer with a real
        // host-shaped placeholder instead: the controller creates its workspace
        // there, and both providers translate the path back into the SSH route.
        const body = await readJson(req);
        if (body === null) { sendJson(res, 400, { code: 'bad-request', message: 'invalid JSON body' }); return; }
        const alias = String(body.alias ?? '');
        const path = String(body.path ?? '');
        if (alias === '' || path === '') {
          sendJson(res, 400, { code: 'bad-request', message: 'alias and path are required' });
          return;
        }
        registry.get(alias);
        const { placeholderPath } = await import('./route.js');
        const placeholder = placeholderPath(alias, path);
        await mkdir(placeholder, { recursive: true });
        sendJson(res, 200, { cwd: placeholder, alias, path });
        return;
      }

      if (req.method === 'GET' && action === 'local/roots') {
        // A directory tree cannot cross a volume: walking up from C:\ stops at
        // the root, so other drives need an explicit entry point. On Windows
        // that is every letter that stats as a directory; elsewhere it is "/".
        /** @type {Array<{name: string, path: string, directory: true}>} */
        const roots = [];
        if (process.platform === 'win32') {
          for (let code = 65; code <= 90; code++) {
            const letter = String.fromCharCode(code);
            const drive = `${letter}:\\`;
            try {
              if ((await stat(drive)).isDirectory()) roots.push({ name: `${letter}:`, path: drive, directory: true });
            } catch {
              /* absent drive */
            }
          }
        } else {
          roots.push({ name: '/', path: '/', directory: true });
        }
        sendJson(res, 200, { roots, home: homedir() });
        return;
      }

      if (req.method === 'POST' && action === 'local/list') {
        // Local browsing exists because taking the `single` directory-flow hole
        // for SSH also removed the shipped native chooser: without this branch
        // the operator could no longer add a LOCAL workspace at all.
        const body = await readJson(req);
        if (body === null) { sendJson(res, 400, { code: 'bad-request', message: 'invalid JSON body' }); return; }
        const requested = String(body.path ?? '');
        const home = homedir();
        // Reject a relative cursor BEFORE normalizing: `resolve()` would
        // silently anchor it to the host process's own cwd, which is not the
        // caller's intent, and must not become a searched directory.
        if (requested !== '' && !isAbsolute(requested)) {
          sendJson(res, 400, { code: 'bad-request', message: 'path must be absolute' });
          return;
        }
        const target = requested === '' ? home : resolvePath(requested);
        const info = await stat(target);
        if (!info.isDirectory()) {
          sendJson(res, 400, { code: 'bad-request', message: `${target} is not a directory` });
          return;
        }
        const dirents = await readdir(target, { withFileTypes: true });
        const parent = dirname(target) === target ? null : dirname(target);
        sendJson(res, 200, {
          path: target,
          home,
          parent,
          entries: dirents
            .filter((entry) => entry.isDirectory())
            // The child's full path travels with the entry so the browser never
            // does separator arithmetic for another platform.
            .map((entry) => ({ name: entry.name, directory: true, path: join(target, entry.name) }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        });
        return;
      }

      if (req.method === 'POST' && action === 'mkdir') {
        const body = await readJson(req);
        if (body === null) { sendJson(res, 400, { code: 'bad-request', message: 'invalid JSON body' }); return; }
        const alias = String(body.alias ?? '');
        const parent = String(body.path ?? '');
        const name = String(body.name ?? '');
        if (alias === '' || parent === '' || name === '') {
          sendJson(res, 400, { code: 'bad-request', message: 'alias, path and name are required' });
          return;
        }
        if (name === '.' || name === '..' || /[/\\]/.test(name)) {
          sendJson(res, 400, { code: 'bad-request', message: 'name must be one path segment' });
          return;
        }
        const connection = registry.get(alias);
        const target = posixResolve(connection.cwd, parent);
        const created = posixResolve(target, name);
        const sftp = await connection.sftp();
        await new Promise((resolve, reject) => {
          sftp.mkdir(created, (error) => (error ? reject(error) : resolve(undefined)));
        });
        sendJson(res, 200, { path: created });
        return;
      }

      if (req.method === 'POST' && action === 'selftest/watch') {
        // Debug-only: proves the polling watcher reports a real remote change.
        if (process.env.DSH_FS_ROUTE_DEBUG !== '1') {
          sendJson(res, 404, { code: 'not-found', message: 'debug endpoints disabled' });
          return;
        }
        const body = await readJson(req);
        const alias = String(body?.alias ?? '');
        const remotePath = String(body?.path ?? '/tmp/dsh-fs-route-watch-probe.txt');
        const fs = /** @type {any} */ (ctx).get?.('fs');
        if (fs === undefined || typeof fs.watch !== 'function') {
          sendJson(res, 503, { code: 'unavailable', message: 'no filesystem provider' });
          return;
        }
        const target = await fs.resolve(`ssh://${alias}${remotePath}`);
        await fs.writeText(target, 'one\n');
        let hits = 0;
        const closed = await fs.watch(target, () => { hits += 1; }, new AbortController().signal);
        // Change the file after the watcher is active, then give the poll a
        // couple of periods to notice.
        await new Promise((r) => setTimeout(r, 300));
        await fs.writeText(target, 'two\n');
        await new Promise((r) => setTimeout(r, 4000));
        await closed();
        const afterClose = hits;
        await fs.writeText(target, 'three\n');
        await new Promise((r) => setTimeout(r, 3500));
        await fs.deleteFile(target);
        sendJson(res, 200, {
          target: remotePath,
          intervalMs: 3000,
          changesWhileActive: afterClose,
          changesAfterClose: hits - afterClose,
        });
        return;
      }

      if (req.method === 'POST' && action === 'selftest/terminal') {
        // Debug-only PTY probe: opens a routed terminal, runs one command, and
        // returns the collected transcript. Enabled by DSH_FS_ROUTE_DEBUG only,
        // because it allocates a real remote shell session.
        if (process.env.DSH_FS_ROUTE_DEBUG !== '1') {
          sendJson(res, 404, { code: 'not-found', message: 'debug endpoints disabled' });
          return;
        }
        const body = await readJson(req);
        const alias = String(body?.alias ?? '');
        const path = String(body?.path ?? '/');
        const command = String(body?.command ?? 'pwd; hostname; echo READY-$((6*7))');
        const subprocess = /** @type {any} */ (ctx).get?.('subprocess');
        if (subprocess === undefined || typeof subprocess.spawnTerminal !== 'function') {
          sendJson(res, 503, { code: 'unavailable', message: 'no subprocess provider' });
          return;
        }
        // An empty alias means the LOCAL world: the request then exercises the
        // shipped terminal backend through `super.spawnTerminal`, which is the
        // regression path that must keep working on this host.
        let cwd = path;
        let argv = ['pwsh', '-NoLogo', '-NoProfile'];
        if (alias !== '') {
          registry.get(alias);
          const { placeholderPath } = await import('./route.js');
          cwd = placeholderPath(alias, path);
        } else {
          // A local terminal needs a real executable path, exactly as the
          // shipped backend passes one.
          try {
            argv = [await subprocess.resolveExecutable('pwsh'), '-NoLogo', '-NoProfile'];
          } catch {
            /* keep the bare name; the failure surfaces in the response */
          }
        }
        const terminal = await subprocess.spawnTerminal({
          // A routed terminal is asked for with the HOST dialect shape on
          // purpose: a Linux host has no pwsh, so the routed provider must pick
          // its own shell.
          argv,
          cwd,
          rows: 40,
          cols: 120,
          terminalType: 'xterm-256color',
          graceMs: 3000,
        });
        /** @type {string} */
        let transcript = '';
        terminal.output.on('data', (chunk) => { transcript += chunk.toString('utf8'); });
        // A login shell needs a beat before it reads input; pwsh starts slower
        // than a POSIX bash, so the local probe waits longer.
        await new Promise((r) => setTimeout(r, alias === '' ? 2500 : 700));
        await terminal.write(`${command}\r`);
        await new Promise((r) => setTimeout(r, alias === '' ? 2500 : 1200));
        const foreground = await terminal.inspectForeground();
        const activity = await terminal.inspectActivity();
        await terminal.terminate();
        sendJson(res, 200, {
          pid: terminal.pid,
          foreground: foreground ?? null,
          activity,
          transcript: transcript.slice(-2000),
        });
        return;
      }

      sendJson(res, 404, { code: 'not-found', message: `unknown action ${JSON.stringify(action)}` });
    } catch (error) {
      const message = /** @type {Error} */ (error)?.message ?? String(error);
      const code = message.includes('unknown ssh alias') ? 400 : 502;
      sendJson(res, code, { code: code === 400 ? 'bad-request' : 'connection-failed', message });
    }
  };

  ctx.effect(() =>
    // `prefix` admits every sub-action under one registration, so the client
    // needs one base URL rather than a route per operation.
    ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'dsh-fs-route: workspace browse routes',
  );
}

export { ROUTE_PREFIX };
