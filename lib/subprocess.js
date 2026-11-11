/**
 * Workspace-routed `ctx.subprocess`.
 *
 * Dispatches on `spec.cwd`: a local path runs through the local provider, an
 * `ssh://<alias>/<abs>` cwd runs on that host over one SSH channel. This keeps
 * `bash`, `grep` and `glob` working for local sessions while a remote session
 * executes on the server — the shipped SSH providers can only move the whole
 * composition to the remote host.
 *
 * The local provider is a REAL `LocalSubprocessRuntime` mounted by this plugin
 * in a child fiber and looked up through the context, not a hand-built object:
 * its spawn path reads `internals`, `ctx.logger`, and lazily probed platform
 * facts, so a synthetic instance would break on the first local command.
 *
 * @module dsh-fs-route/subprocess
 */
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { parseAnyRoute } from './route.js';
import { quote } from './ssh.js';

/**
 * Bounded text accumulator mirroring the collected-output contract.
 */
class Collector {
  /** @param {number} maxBytes - in-memory cap; overflow keeps the tail. */
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    /** @type {string} */
    this.buffer = '';
    /** @type {number} */
    this.dropped = 0;
  }

  /**
   * Append one decoded chunk, keeping a bounded tail.
   * @param {string} text - decoded chunk.
   */
  push(text) {
    this.buffer += text;
    while (Buffer.byteLength(this.buffer, 'utf8') > this.maxBytes && this.buffer.length > 0) {
      const cut = Math.ceil(this.buffer.length / 8);
      this.buffer = this.buffer.slice(cut);
      this.dropped += cut;
    }
  }

  /** A reader over this accumulator. */
  get reader() {
    const self = this;
    return {
      /**
       * @param {number} fromByte - resume offset.
       * @returns {{text: string, nextOffset: number, lossy: boolean}} the read.
       */
      readFrom(fromByte) {
        const lossy = fromByte < self.dropped;
        const text = lossy ? self.buffer : self.buffer.slice(Math.max(0, fromByte - self.dropped));
        return { text, nextOffset: self.dropped + self.buffer.length, lossy };
      },
    };
  }
}

/**
 * One remote process presented through the `SubprocessHandle` shape.
 */
class RemoteHandle {
  /**
   * @param {import('ssh2').ClientChannel} stream - the exec channel.
   * @param {{stdout?: Collector, stderr?: Collector}} collectors - output buffers.
   */
  constructor(stream, collectors) {
    this.stream = stream;
    this.collectors = collectors;
    this.stdin = undefined;
    this.stdout = undefined;
    this.stderr = undefined;
    this.control = undefined;
    this.collected = {
      stdout: collectors.stdout?.reader,
      stderr: collectors.stderr?.reader,
    };
    this.done = new Promise((resolve, reject) => {
      stream.on('close', (code, signal) => resolve({ exitCode: typeof code === 'number' ? code : null, signal: signal ?? null }));
      stream.on('error', (error) => reject(error));
    });
  }

  /** Start termination of the remote command. */
  terminate() {
    try {
      this.stream.signal('TERM');
    } catch {
      /* channel already closed */
    }
  }
  /**
   * Wait for the remote command to close.
   * @param {AbortSignal} [signal] - bound for the wait.
   * @returns {Promise<boolean>} true when closed, false when the signal aborted.
   */
  async waitForExit(signal) {
    if (signal === undefined) {
      await this.done.catch(() => undefined);
      return true;
    }
    return await Promise.race([
      this.done.then(() => true).catch(() => true),
      new Promise((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true })),
    ]);
  }
}

/**
 * The route-aware subprocess provider.
 *
 * Extends the shipped local provider rather than wrapping it. `spawn` for a
 * local cwd is literally `super.spawn`, so the local world keeps the real
 * implementation — platform confinement probes, managed-range teardown, spill
 * files, dispose semantics — with no re-implementation and no synthetic
 * instance. Only a routed `ssh://` cwd takes the SSH path.
 */
export class RoutedSubprocessRuntime extends LocalSubprocessRuntime {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - mounting context.
   * @param {{deps: {registry: import('./ssh.js').SshRegistry}}} options - plugin wiring.
   */
  constructor(ctx, options) {
    super(ctx);
    this.registry = options.deps.registry;
    /** @type {Set<RemoteHandle>} */
    this.remote = new Set();
    ctx.effect(() => async () => {
      for (const handle of this.remote) handle.terminate();
      for (const handle of this.remote) await handle.waitForExit();
      this.remote.clear();
    });
  }

  /**
   * Split a caller cwd into a route.
   *
   * A routed cwd usually arrives verbatim, but the bash tool's
   * `resolveWorkdir()` treats `ssh://…` as a RELATIVE path on Windows
   * (`path.isAbsolute('ssh://h/p')` is false there, because `ssh:` is not a
   * drive letter) and prefixes the session cwd, yielding
   * `C:\…\workspace\ssh://gpu/p`. Both spellings name the same route, so the
   * cwd is scanned for an embedded `ssh://` before giving up on it.
   * @param {string} cwd - the spec's working directory.
   * @returns {{alias: string, path: string} | null} the route, or null for local.
   */
  route(cwd) {
    return parseAnyRoute(cwd, (a) => this.registry.has(a));
  }

  /**
   * Resolve one executable.
   *
   * This seam carries no cwd, so the local world answers first. A routed spawn
   * needs a POSIX name like `bash`, which a Windows host cannot resolve — and
   * the bash executor calls this BEFORE spawning, so a hard failure here aborts
   * remote commands entirely. When local resolution fails and any alias is
   * configured, the bare name is returned for the remote side to resolve
   * against the login PATH in `_spawnRemote`.
   * @param {string} command - absolute path or bare name.
   * @param {Readonly<Record<string, string>>} [env] - lookup environment.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string>} a canonical executable path.
   */
  async resolveExecutable(command, env, signal) {
    try {
      return await super.resolveExecutable(command, env, signal);
    } catch (error) {
      // An absolute path is verified by the local provider and a miss is real;
      // only a bare name may legitimately exist on the remote host instead.
      if (command.includes('/') || command.includes('\\')) throw error;
      if (this.registry.aliases.length === 0) throw error;
      for (const alias of this.registry.aliases) {
        const found = await this._remoteExecutable(alias, command, signal);
        if (found !== command) return found;
      }
      // Unresolvable remotely too: return the bare name so the remote shell's
      // own PATH lookup decides, rather than failing the whole call here.
      return command;
    }
  }

  /**
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<import('@deepseek-ai/dsh-subprocess').SubprocessTerminalEnvironment>} shell facts.
   */
  async terminalEnvironment(signal) {
    return await super.terminalEnvironment(signal);
  }

  /**
   * Resolve a remote executable for one routed argv[0].
   *
   * A bare name is looked up on the remote PATH. A HOST absolute path is a
   * different case: consumers such as the search tools pass the harness's own
   * bundled binary (`…\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`), which
   * does not exist on a Linux server. For those the basename is resolved on the
   * remote PATH instead, so `grep`/`glob` work against a routed workspace.
   * @param {string} alias - route alias.
   * @param {string} command - bare name or absolute path.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string>} the remote absolute path, or the input when unresolved.
   */
  async _remoteExecutable(alias, command, signal) {
    const hostShaped = /^[A-Za-z]:[\\/]/.test(command) || command.startsWith('\\\\');
    if (hostShaped) {
      // Strip the Windows executable suffix, then look the name up remotely.
      const base = command.split(/[\\/]/).pop() ?? command;
      const name = base.replace(/\.(exe|cmd|bat)$/i, '');
      const found = await this._lookup(alias, name, signal);
      return found ?? name;
    }
    if (command.includes('/')) return command;
    return (await this._lookup(alias, command, signal)) ?? command;
  }

  /**
   * Ask the remote login shell where one command lives.
   * @param {string} alias - route alias.
   * @param {string} name - bare command name.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string | undefined>} the absolute path, or undefined.
   */
  async _lookup(alias, name, signal) {
    const outcome = await this.registry.get(alias).exec(`command -v ${quote(name)}`, { signal });
    const found = outcome.stdout.trim().split('\n')[0];
    return found === '' ? undefined : found;
  }

  /**
   * @param {import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec} spec - the spawn request.
   * @returns {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} the live handle.
   */
  spawn(spec) {
    const route = this.route(spec.cwd);
    if (route === null) return super.spawn(spec);
    return this._spawnRemote(route, spec);
  }

  /**
   * Start one remote process over an SSH exec channel.
   * @param {{alias: string, path: string}} route - the target route.
   * @param {import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec} spec - the spawn request.
   * @returns {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} the live handle.
   */
  _spawnRemote(route, spec) {
    const connection = this.registry.get(route.alias);
    const collectors = {
      stdout: isCollect(spec.stdio.stdout) ? new Collector(spec.stdio.stdout.maxBytes) : undefined,
      stderr: isCollect(spec.stdio.stderr) ? new Collector(spec.stdio.stderr.maxBytes) : undefined,
    };

    let remote;
    let failure;

    const preparation = (async () => {
      const client = await connection.client(spec.signal);
      const argv = [...spec.argv];
      if (argv[0] !== undefined) argv[0] = await this._remoteExecutable(route.alias, argv[0], spec.signal);
      const finalArgv = withSearchRoot(argv);
      const command = `${renderEnv(spec.env)}${renderArgv(finalArgv)}`;
      if (process.env.DSH_FS_ROUTE_DEBUG === '1') {
        console.error('[dsh-fs-route] remote argv:', JSON.stringify(finalArgv.slice(0, 6)), '| cwd:', route.path);
      }
      // The working directory is applied with an explicit `cd`, not ssh2's
      // exec options: not every server honors a start directory for a login
      // shell, and a silently wrong cwd would run commands in the wrong tree.
      const stream = await new Promise((resolve, reject) => {
        client.exec(`cd ${quote(route.path)} && ${command}`, (error, channel) => (error ? reject(error) : resolve(channel)));
      });
      stream.on('data', (chunk) => collectors.stdout?.push(chunk.toString('utf8')));
      stream.stderr.on('data', (chunk) => collectors.stderr?.push(chunk.toString('utf8')));
      if (spec.stdio.stdin === 'ignore') stream.end();
      else if (typeof spec.stdio.stdin === 'object') stream.end(spec.stdio.stdin.data);
      remote = new RemoteHandle(stream, collectors);
      this.live.add(remote);
      const release = () => this.live.delete(remote);
      void remote.done.then(release, release).catch(() => undefined);
      spec.signal?.addEventListener('abort', () => remote?.terminate(), { once: true });
    })().catch((error) => {
      failure = error;
    });

    return /** @type {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} */ ({
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {
        stdout: collectors.stdout?.reader,
        stderr: collectors.stderr?.reader,
      },
      done: preparation.then(() => {
        if (failure !== undefined) throw failure;
        return remote.done;
      }),
      terminate: () => remote?.terminate(),
      waitForExit: async (signal) => {
        await preparation;
        if (failure !== undefined) return true;
        return await (remote?.waitForExit(signal) ?? true);
      },
    });
  }

  /**
   * Start one terminal session on the SSH host.
   *
   * Implemented with an SSH **shell** channel requested with a PTY, which is the
   * only interactive primitive the transport offers. Limits that are inherent
   * to SSH (documented, not worked around):
   *
   * - the remote side reports no pid, so `pid` is `-1`;
   * - there is no portable way to read the foreground process group, so
   *   `inspectForeground` reports `undefined` and `signalForeground` sends the
   *   signal to the channel's own process (returning `0` for the unknown group);
   * - activity is unobservable, so `inspectActivity` reports `unknown`, which
   *   makes the PTY consumer fall back to output-silence idleness.
   * @param {import('@deepseek-ai/dsh-subprocess').SubprocessTerminalSpawnSpec} spec - the terminal request.
   * @returns {Promise<import('@deepseek-ai/dsh-subprocess').SubprocessTerminalHandle>} the live handle.
   */
  async spawnTerminal(spec) {
    const route = this.route(spec.cwd);
    if (route === null) return await super.spawnTerminal(spec);

    const connection = this.registry.get(route.alias);
    const client = await connection.client(spec.signal);
    // The caller's argv is shaped by the HOST dialect (on Windows the shipped
    // terminal backend asks for pwsh), and a Linux host has no pwsh. The
    // execution world decides the shell here, exactly as it does for a routed
    // command, so the remote side always gets a POSIX login shell.
    const shell = await this._remoteExecutable(route.alias, 'bash', spec.signal);
    const command = `cd ${quote(route.path)} && exec ${quote(shell)} -l`;

    const stream = await new Promise((resolve, reject) => {
      client.shell(
        {
          term: spec.terminalType || 'xterm-256color',
          cols: spec.cols,
          rows: spec.rows,
        },
        (error, channel) => (error ? reject(error) : resolve(channel)),
      );
    });

    // Drive the login shell to the requested directory by typing `cd` once the
    // PTY is up; an SSH shell channel has no "exec in a PTY" form.
    stream.write(`${command}\r`);

    let settled = false;
    const done = new Promise((resolve, reject) => {
      stream.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        resolve({
          exitCode: typeof code === 'number' ? code : null,
          signal: typeof signal === 'string' ? signal : null,
        });
      });
      stream.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    // An unobserved rejection would crash the host; the tool layer reads `done`.
    void done.catch(() => undefined);

    const handle = {
      // SSH exposes no remote pid for a shell channel.
      pid: -1,
      output: stream,
      done,
      /**
       * @param {string} data - text to deliver to the terminal.
       * @returns {Promise<void>} resolves after the write is queued.
       */
      async write(data) {
        stream.write(data);
      },
      /**
       * @param {number} cols - columns.
       * @param {number} rows - rows.
       * @returns {Promise<void>} resolves after the window change is sent.
       */
      async resize(cols, rows) {
        stream.setWindow(rows, cols, 0, 0);
      },
      /**
       * SSH cannot read the remote foreground process group.
       * @returns {Promise<undefined>} always undefined.
       */
      async inspectForeground() {
        return undefined;
      },
      /**
       * No portable remote activity observation exists.
       * @returns {Promise<{state: 'unknown', revision: number}>} an unknown observation.
       */
      async inspectActivity() {
        return { state: /** @type {const} */ ('unknown'), revision: 0 };
      },
      /**
       * Send one signal to the channel's remote command.
       * @param {import('@deepseek-ai/dsh-subprocess').SubprocessTerminalSignal} signal - the signal.
       * @returns {Promise<number>} 0, because the remote group id is unknowable here.
       */
      async signalForeground(signal) {
        try {
          stream.signal(signal.replace(/^SIG/, ''));
        } catch {
          /* channel already gone */
        }
        return 0;
      },
      /**
       * Close the channel and wait for the remote shell to settle.
       * @returns {Promise<void>} resolves after quiescence.
       */
      async terminate() {
        try {
          stream.end();
          stream.close();
        } catch {
          /* already closed */
        }
        await done.catch(() => undefined);
      },
    };

    return /** @type {import('@deepseek-ai/dsh-subprocess').SubprocessTerminalHandle} */ (handle);
  }
}

/**
 * Render one argv as remote shell words.
 *
 * A caller that spawns `bash -c <script>` intends the script to be parsed by
 * the remote shell, but the script is still ONE argument: emitting it bare
 * would let the outer shell split it (`bash -c exit 42` runs `exit` with `42`
 * as `$0`). It is therefore wrapped in double quotes, which keeps it a single
 * word while still allowing the inner shell to expand globs and variables —
 * `ls *.py` expands, and `rg "^def "` keeps its caret. Every other argument is
 * single-quoted literally.
 * @param {readonly string[]} argv - the caller's argv.
 * @returns {string} the shell command text.
 */
function renderArgv(argv) {
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    const isShellScript = i > 0 && argv[i - 1] === '-c';
    if (isShellScript) {
      // Escape the characters that stay special inside double quotes.
      const escaped = argv[i].replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$');
      parts.push(`"${escaped}"`);
      continue;
    }
    parts.push(quote(argv[i]));
  }
  return parts.join(' ');
}

/**
 * Flags whose value is a SEPARATE argv element. Only these make the following
 * token non-positional; every other `--flag=value` carries its value inline.
 */
const VALUE_FLAGS = new Set(['-e', '--regexp', '-g', '--glob', '-t', '--type', '-m', '--max-count', '-j', '--threads', '-A', '--after-context', '-B', '--before-context', '-C', '--context', '--sort', '--sortr', '-f', '--file', '--type-not', '-T']);

/**
 * Give a ripgrep invocation an explicit search root when the caller omitted one.
 *
 * The search tools run `rg <flags>` with the working directory as the implied
 * root and `stdin: 'ignore'`. On a POSIX host that mode makes ripgrep read
 * STDIN (which is `/dev/null`) and report zero matches instead of walking the
 * directory; a Windows `NUL` does not trigger that branch, which is why the
 * local deployment never sees it. Appending `.` restores the intended
 * "search the working directory" behaviour without changing any other argument.
 * @param {readonly string[]} argv - the caller's argv, argv[0] already resolved.
 * @returns {readonly string[]} the argv to run, with a root when one was implied.
 */
function withSearchRoot(argv) {
  if (argv.length === 0) return argv;
  const program = (argv[0].split('/').pop() ?? '').replace(/\.(exe|cmd|bat)$/i, '');
  if (program !== 'rg') return argv;

  let hasPositional = false;
  let expectValue = false;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (expectValue) { expectValue = false; continue; }
    if (token === '--') {
      // Everything after the terminator is positional by definition.
      if (i + 1 < argv.length) hasPositional = true;
      break;
    }
    if (token.startsWith('-')) {
      if (!token.includes('=') && VALUE_FLAGS.has(token)) expectValue = true;
      continue;
    }
    hasPositional = true;
  }
  return hasPositional ? argv : [...argv, '.'];
}

/**
 * Whether one output disposition asks for bounded collection.
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessOutputMode} mode - the disposition.
 * @returns {boolean} true for a collect object.
 */
function isCollect(mode) {
  return typeof mode === 'object' && mode !== null && typeof mode.maxBytes === 'number';
}

/**
 * Render explicit environment entries as a shell prefix. Tombstones (an
 * `undefined` value) are dropped, and names that are not valid identifiers are
 * ignored rather than injected.
 * @param {NodeJS.ProcessEnv | undefined} env - caller environment.
 * @returns {string} the `NAME=value ` prefix, or an empty string.
 */
function renderEnv(env) {
  if (env === undefined) return '';
  let out = '';
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out += `${key}=${quote(value)} `;
  }
  return out;
}

export default RoutedSubprocessRuntime;
