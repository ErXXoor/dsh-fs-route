/**
 * Workspace-routed `ctx.fs`.
 *
 * One provider, two execution worlds, chosen per operation:
 *
 *   - a local target or host-shaped path -> the real local filesystem
 *   - an `ssh://<alias>/<path>` target   -> the remote host over SFTP
 *
 * Local work reuses `@deepseek-ai/dsh-fs-local`'s own prototype methods through
 * a non-registering instance, so local semantics (realpath identity, atomic
 * publication, stale guards) are that implementation's, verbatim. It is created
 * with `Object.create` rather than `new` because Cordis' `Service` constructor
 * registers immediately and would claim the `fs` slot ahead of this provider.
 *
 * @module dsh-fs-route/fs
 */
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { basename, posix as posixPath } from 'node:path';
import { decodeKey, encodeKey, isPosixAbsolute, parseAnyRoute, posixJoin } from './route.js';

/**
 * Local base class for the routed provider.
 *
 * With a `sandboxPolicy` in the composition the routed provider extends the
 * SANDBOXED local backend, so local writes keep exactly the confinement the
 * deployment had before this plugin was installed. Remote writes are unfenced
 * by construction (SFTP has no host ACL to enforce a workspace boundary with),
 * which the provider reports honestly through `sandboxMode`.
 *
 * A composition without the sandbox backend still works: the plain local
 * backend is the fallback.
 */
let LocalBase = LocalFileSystem;
try {
  const mod = await import('@deepseek-ai/dsh-fs-sandbox');
  if (typeof mod.SandboxedFileSystem === 'function') LocalBase = mod.SandboxedFileSystem;
} catch {
  /* no sandbox backend in this composition */
}

/** SFTP status codes mapped onto the shared filesystem error taxonomy. */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;

/**
 * Map an SFTP failure onto the shared filesystem error taxonomy.
 * @param {unknown} error - the thrown SFTP error.
 * @param {string} path - the path being operated on.
 * @returns {FsError} the typed error.
 */
function sftpError(error, path) {
  const code = /** @type {{code?: number}} */ (error)?.code;
  if (code === SFTP_NO_SUCH_FILE) return new FsError(`No such file or directory: ${path}`, 'FS_NOT_FOUND', { cause: error });
  if (code === SFTP_PERMISSION_DENIED) return new FsError(`Permission denied: ${path}`, 'FS_PERMISSION_DENIED', { cause: error });
  return new FsError(`Filesystem error on ${path}: ${/** @type {Error} */ (error)?.message ?? String(error)}`, 'FS_IO_ERROR', { cause: error });
}

/**
 * Derive a freshness token from SFTP stat facts.
 * @param {import('ssh2').Stats} stats - SFTP stat result.
 * @returns {FsVersion} the opaque version token.
 */
function versionOf(stats) {
  return FsVersion(`sftp:${stats.size}:${stats.mtime}:${stats.mode}`);
}

/**
 * Classify an SFTP stat result.
 * @param {import('ssh2').Stats} stats - SFTP stat result.
 * @returns {'file' | 'directory' | 'other'} the classification.
 */
function typeOf(stats) {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

/**
 * Promisify one SFTP callback method.
 * @param {object} sftp - the SFTP wrapper.
 * @param {string} method - method name.
 * @param {...unknown} args - method arguments.
 * @returns {Promise<any>} the callback result.
 */
function call(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    /** @type {Record<string, Function>} */ (sftp)[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

/**
 * The route-aware filesystem provider.
 *
 * Extends the shipped local backend rather than wrapping it, mirroring how
 * `dsh-fs-sandbox` decorates `dsh-fs-local`: local operations are `super.*`, so
 * realpath identity, atomic publication and stale guards stay the shipped
 * implementation's. Only a target carrying an SSH route takes the SFTP path.
 */
export class RoutedFileSystem extends LocalBase {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - mounting context.
   * @param {{config?: object, deps: {registry: import('./ssh.js').SshRegistry, defaultHost?: string}}} options - plugin wiring.
   */
  constructor(ctx, options) {
    // `LocalFileSystem` requires an ALREADY-RESOLVED config: its constructor
    // asserts `diffBasisMaxBytes` is a positive integer and never fills a
    // default itself — that is Schemastery's job at mount time. When this class
    // is mounted directly (or by `ctx.plugin` with a plain object), no schema
    // ran, so apply the base schema here; an omitted field would otherwise
    // reject the whole provider and leave `ctx.fs` unregistered.
    super(ctx, LocalFileSystem.Config?.(options.config ?? {}) ?? options.config ?? {});
    this.registry = options.deps.registry;
    this.defaultHost = options.deps.defaultHost;
    /** Remote watch sample period; 0 rejects remote watching outright. */
    this.watchIntervalMs = options.deps.watchIntervalMs ?? 3000;
  }

  // `sandboxMode` is inherited from the local base: it reports the mode this
  // deployment enforces on LOCAL targets, which is what the tool layer must
  // advertise. A routed target is unfenced (SFTP offers no host ACL to fence
  // with), and that limit is documented rather than silently reported as a
  // mode this provider cannot keep.

  /**
   * Split a caller cwd into a route.
   *
   * Mirrors the subprocess provider: a routed cwd normally arrives verbatim,
   * but a host-path join on Windows can displace `ssh://…` into the middle of
   * the string (Node's `path.isAbsolute` reports false for it there). The
   * embedded spelling names the same route.
   * @param {string | undefined} cwd - caller-supplied working directory.
   * @returns {{alias: string | undefined, cwd: string | undefined}} the route.
   */
  routeOf(cwd) {
    if (cwd === undefined) return { alias: undefined, cwd: undefined };
    const route = parseAnyRoute(cwd, (a) => this.registry.has(a));
    if (route !== null) return { alias: route.alias, cwd: route.path };
    return { alias: undefined, cwd };
  }

  /**
   * @param {string} path - path to resolve.
   * @param {{cwd?: string, signal?: AbortSignal}} [opts] - cwd and cancellation.
   * @returns {Promise<import('@deepseek-ai/dsh-fs').FsTarget>} the stable target.
   */
  async resolve(path, opts = {}) {
    const direct = parseAnyRoute(path, (a) => this.registry.has(a));
    if (direct !== null) {
      this.registry.get(direct.alias);
      const canonical = await this.canonical(direct.alias, direct.path, opts.signal);
      return { targetKey: FsTargetKey(encodeKey(direct.alias, canonical)), displayPath: path };
    }
    const { alias, cwd } = this.routeOf(opts.cwd);
    if (alias === undefined) return await super.resolve(path, opts);
    const absolute = isPosixAbsolute(path) ? path : posixJoin(cwd ?? this.registry.get(alias).cwd, path);
    const canonical = await this.canonical(alias, absolute, opts.signal);
    return { targetKey: FsTargetKey(encodeKey(alias, canonical)), displayPath: path };
  }

  /**
   * Canonicalize a remote path, tolerating a missing leaf so creates resolve.
   * @param {string} alias - route alias.
   * @param {string} absolute - absolute POSIX path.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string>} the canonical remote path.
   */
  async canonical(alias, absolute, signal) {
    const sftp = await this.registry.get(alias).sftp(signal);
    try {
      return await call(sftp, 'realpath', absolute);
    } catch (error) {
      if (/** @type {{code?: number}} */ (error)?.code !== SFTP_NO_SUCH_FILE) throw sftpError(error, absolute);
      const parent = posixPath.dirname(absolute);
      if (parent === absolute) return absolute;
      const realParent = await this.canonical(alias, parent, signal);
      return realParent === '/' ? `/${basename(absolute)}` : `${realParent}/${basename(absolute)}`;
    }
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - a target from this provider.
   * @returns {string} the path a process in that world can open.
   */
  processPath(target) {
    const { alias, path } = decodeKey(String(target.targetKey));
    return alias === undefined ? super.processPath(target) : path;
  }

  /**
   * @param {string} hostPath - absolute host path.
   * @returns {string | undefined} the process path, or undefined when unmapped.
   */
  processPathFromHostPath(hostPath) {
    return super.processPathFromHostPath(hostPath);
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - a target from this provider.
   * @returns {string} the canonical file URI.
   */
  fileUrl(target) {
    const { alias, path } = decodeKey(String(target.targetKey));
    if (alias === undefined) return super.fileUrl(target);
    const encoded = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    return `ssh://${alias}${encoded}`;
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} parent - candidate ancestor.
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} child - candidate descendant.
   * @returns {boolean} whether child is parent or under it.
   */
  contains(parent, child) {
    const a = decodeKey(String(parent.targetKey));
    const b = decodeKey(String(child.targetKey));
    if (a.alias !== b.alias) return false;
    if (a.alias === undefined) return super.contains(parent, child);
    if (a.path === b.path) return true;
    const prefix = a.path.endsWith('/') ? a.path : a.path + '/';
    return b.path.startsWith(prefix);
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - target to stat.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<import('@deepseek-ai/dsh-fs').FsInfo | undefined>} metadata, or undefined when absent.
   */
  async stat(target, signal) {
    const { alias, path } = decodeKey(String(target.targetKey));
    if (alias === undefined) return await super.stat(target, signal);
    const sftp = await this.registry.get(alias).sftp(signal);
    try {
      const stats = await call(sftp, 'stat', path);
      return { version: versionOf(stats), type: typeOf(stats), size: Number(stats.size) };
    } catch (error) {
      if (/** @type {{code?: number}} */ (error)?.code === SFTP_NO_SUCH_FILE) return undefined;
      throw sftpError(error, path);
    }
  }

  /**
   * @param {string} path - path to inspect without following the leaf.
   * @param {{cwd?: string}} [opts] - cwd override.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<import('@deepseek-ai/dsh-fs').FsPathInfo | undefined>} path metadata.
   */
  async lstat(path, opts = {}, signal) {
    const direct = parseAnyRoute(path, (a) => this.registry.has(a));
    const { alias, cwd } = direct !== null ? { alias: direct.alias, cwd: direct.path } : this.routeOf(opts.cwd);
    if (alias === undefined) return await super.lstat(path, opts, signal);
    const absolute = direct !== null ? direct.path : isPosixAbsolute(path) ? path : posixJoin(cwd ?? this.registry.get(alias).cwd, path);
    const sftp = await this.registry.get(alias).sftp(signal);
    try {
      const stats = await call(sftp, 'lstat', absolute);
      const type = stats.isSymbolicLink() ? 'symlink' : typeOf(stats);
      return { version: versionOf(stats), type, size: Number(stats.size) };
    } catch (error) {
      if (/** @type {{code?: number}} */ (error)?.code === SFTP_NO_SUCH_FILE) return undefined;
      throw sftpError(error, absolute);
    }
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - file to read.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string>} decoded UTF-8 content.
   */
  async readText(target, signal) {
    const { alias, path } = decodeKey(String(target.targetKey));
    if (alias === undefined) return await super.readText(target, signal);
    return (await this._readAll(alias, path)).toString('utf8');
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - file to stream.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<AsyncIterable<string>>} decoded chunks.
   */
  async streamText(target, signal) {
    const { alias, path } = decodeKey(String(target.targetKey));
    if (alias === undefined) return await super.streamText(target, signal);
    const text = (await this._readAll(alias, path)).toString('utf8');
    return (async function* () {
      const CHUNK = 64 * 1024;
      for (let at = 0; at < text.length; at += CHUNK) yield text.slice(at, at + CHUNK);
    })();
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - file to read.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @param {number} maxBytes - inclusive cap.
   * @returns {Promise<Uint8Array>} raw bytes.
   */
  async readBytes(target, signal, maxBytes) {
    const { alias, path } = decodeKey(String(target.targetKey));
    if (alias === undefined) return await super.readBytes(target, signal, maxBytes);
    const info = await this.stat(target, signal);
    if (info?.size !== undefined && info.size > maxBytes) throw new FsError(`File is too large to read: ${path}`, 'FS_TOO_LARGE');
    const bytes = await this._readAll(alias, path);
    if (bytes.length > maxBytes) throw new FsError(`File is too large to read: ${path}`, 'FS_TOO_LARGE');
    return bytes;
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - file to read.
   * @param {{offset: number, length: number}} range - byte window.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<Uint8Array>} the window's bytes.
   */
  async readByteRange(target, range, signal) {
    const { alias, path } = decodeKey(String(target.targetKey));
    if (alias === undefined) return await super.readByteRange(target, range, signal);
    const sftp = await this.registry.get(alias).sftp(signal);
    const buffer = Buffer.alloc(range.length);
    const handle = await call(sftp, 'open', path, 'r');
    try {
      const read = await call(handle, 'read', buffer, 0, range.length, range.offset);
      return new Uint8Array(buffer.subarray(0, read.bytesRead));
    } finally {
      await call(handle, 'close').catch(() => undefined);
    }
  }

  /**
   * Read a whole remote file.
   * @param {string} alias - route alias.
   * @param {string} path - remote path.
   * @returns {Promise<Buffer>} the file content.
   */
  async _readAll(alias, path) {
    const sftp = await this.registry.get(alias).sftp();
    return await new Promise((resolve, reject) => {
      const chunks = [];
      const stream = sftp.createReadStream(path);
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', (error) => reject(sftpError(error, path)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - directory to list.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<import('@deepseek-ai/dsh-fs').FsDirEntry[]>} direct children.
   */
  async listDir(target, signal) {
    const { alias, path } = decodeKey(String(target.targetKey));
    if (alias === undefined) return await super.listDir(target, signal);
    const sftp = await this.registry.get(alias).sftp(signal);
    let entries;
    try {
      entries = await call(sftp, 'readdir', path);
    } catch (error) {
      throw sftpError(error, path);
    }
    const out = entries.map((entry) => {
      const childPath = path === '/' ? `/${entry.filename}` : `${path}/${entry.filename}`;
      return {
        name: entry.filename,
        type: entry.attrs.isDirectory() ? 'directory' : entry.attrs.isFile() ? 'file' : 'other',
        target: { targetKey: FsTargetKey(encodeKey(alias, childPath)), displayPath: childPath },
        version: versionOf(entry.attrs),
        size: Number(entry.attrs.size),
      };
    });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - file to write.
   * @param {string} content - new content.
   * @param {import('@deepseek-ai/dsh-fs').FsWriteIntent} [expected] - guard.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<import('@deepseek-ai/dsh-fs').FsWriteOutcome>} the outcome.
   */
  async writeText(target, content, expected, signal, sandboxPolicy) {
    const { alias, path } = decodeKey(String(target.targetKey));
    if (alias === undefined) return await super.writeText(target, content, expected, signal, sandboxPolicy);

    const before = await this._readIfPresent(alias, path);
    if (expected?.kind === 'createIfAbsent' && before !== null) throw new FsError(`File already exists: ${path}`, 'FS_STALE_VERSION');
    if (expected?.kind === 'replaceIfVersion') {
      const fresh = await this.stat(target, signal);
      if (fresh === undefined || String(fresh.version) !== String(expected.version)) {
        throw new FsError(`File changed since it was read: ${path}`, 'FS_STALE_VERSION');
      }
    }
    await this._writeAll(alias, path, Buffer.from(content, 'utf8'));
    const after = await this.stat(target, signal);
    return {
      operation: before === null ? 'create' : 'update',
      version: /** @type {FsVersion} */ (after?.version ?? FsVersion('sftp:unknown')),
      before: before === null ? null : before.toString('utf8'),
      after: content,
    };
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - file to edit.
   * @param {{oldString: string, newString: string, replaceAll: boolean}} edit - literal edit.
   * @param {{version: FsVersion}} [expected] - version guard.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<import('@deepseek-ai/dsh-fs').FsEditOutcome>} the outcome.
   */
  async editText(target, edit, expected, signal, sandboxPolicy) {
    const { alias, path } = decodeKey(String(target.targetKey));
    if (alias === undefined) return await super.editText(target, edit, expected, signal, sandboxPolicy);

    const before = await this._readIfPresent(alias, path);
    if (before === null) throw new FsError(`File does not exist: ${path}`, 'FS_NOT_FOUND');
    const text = before.toString('utf8');
    if (edit.oldString === '') throw new FsError('Edit pattern must not be empty', 'FS_EDIT_NOT_FOUND');
    const first = text.indexOf(edit.oldString);
    if (first < 0) throw new FsError(`Edit pattern not found in ${path}`, 'FS_EDIT_NOT_FOUND');
    if (!edit.replaceAll && text.indexOf(edit.oldString, first + edit.oldString.length) >= 0) {
      throw new FsError(`Edit pattern is ambiguous in ${path}`, 'FS_AMBIGUOUS_EDIT');
    }
    if (expected !== undefined) {
      const fresh = await this.stat(target, signal);
      if (fresh === undefined || String(fresh.version) !== String(expected.version)) {
        throw new FsError(`File changed since it was read: ${path}`, 'FS_STALE_VERSION');
      }
    }
    const after = edit.replaceAll
      ? text.split(edit.oldString).join(edit.newString)
      : text.slice(0, first) + edit.newString + text.slice(first + edit.oldString.length);
    await this._writeAll(alias, path, Buffer.from(after, 'utf8'));
    const fresh = await this.stat(target, signal);
    return { version: /** @type {FsVersion} */ (fresh?.version ?? FsVersion('sftp:unknown')), before: text, after };
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - file to patch.
   * @param {readonly import('@deepseek-ai/dsh-fs-patch').PatchHunk[]} hunks - hunks.
   * @param {{version: FsVersion}} [expected] - guard.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<import('@deepseek-ai/dsh-fs').FsEditOutcome>} the outcome.
   */
  async patchText(target, hunks, expected, signal, sandboxPolicy) {
    const { alias, path } = decodeKey(String(target.targetKey));
    if (alias === undefined) return await super.patchText(target, hunks, expected, signal, sandboxPolicy);
    const { applyPatch } = await import('./patch.js');
    const before = await this._readIfPresent(alias, path);
    if (before === null) throw new FsError(`File does not exist: ${path}`, 'FS_NOT_FOUND');
    const text = before.toString('utf8');
    const after = applyPatch(text, hunks);
    if (expected !== undefined) {
      const fresh = await this.stat(target, signal);
      if (fresh === undefined || String(fresh.version) !== String(expected.version)) {
        throw new FsError(`File changed since it was read: ${path}`, 'FS_STALE_VERSION');
      }
    }
    await this._writeAll(alias, path, Buffer.from(after, 'utf8'));
    const fresh = await this.stat(target, signal);
    return { version: /** @type {FsVersion} */ (fresh?.version ?? FsVersion('sftp:unknown')), before: text, after };
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - file to remove.
   * @param {{version: FsVersion}} [expected] - guard.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<import('@deepseek-ai/dsh-fs').FsDeleteOutcome>} the outcome.
   */
  async deleteFile(target, expected, signal, sandboxPolicy) {
    const { alias, path } = decodeKey(String(target.targetKey));
    if (alias === undefined) return await super.deleteFile(target, expected, signal, sandboxPolicy);
    const before = await this._readIfPresent(alias, path);
    if (before === null) throw new FsError(`File does not exist: ${path}`, 'FS_NOT_FOUND');
    if (expected !== undefined) {
      const fresh = await this.stat(target, signal);
      if (fresh === undefined || String(fresh.version) !== String(expected.version)) {
        throw new FsError(`File changed since it was read: ${path}`, 'FS_STALE_VERSION');
      }
    }
    const sftp = await this.registry.get(alias).sftp(signal);
    try {
      await call(sftp, 'unlink', path);
    } catch (error) {
      throw sftpError(error, path);
    }
    return { before: before.toString('utf8') };
  }

  /**
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} source - file to move.
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} destination - destination.
   * @param {object} options - guards and optional hunks.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<import('@deepseek-ai/dsh-fs').FsMoveOutcome>} the outcome.
   */
  async moveFile(source, destination, options, signal, sandboxPolicy) {
    const a = decodeKey(String(source.targetKey));
    const b = decodeKey(String(destination.targetKey));
    if (a.alias === undefined && b.alias === undefined) return await super.moveFile(source, destination, options, signal, sandboxPolicy);
    if (a.alias !== b.alias) throw new FsError('Cross-world moves are not supported', 'FS_IO_ERROR');

    const { alias } = a;
    const before = await this._readIfPresent(alias, a.path);
    if (before === null) throw new FsError(`File does not exist: ${a.path}`, 'FS_NOT_FOUND');
    const text = before.toString('utf8');
    const content = options?.hunks === undefined ? text : (await import('./patch.js')).applyPatch(text, options.hunks);
    await this._writeAll(alias, b.path, Buffer.from(content, 'utf8'));
    const sftp = await this.registry.get(alias).sftp(signal);
    try {
      await call(sftp, 'unlink', a.path);
    } catch (error) {
      const failed = sftpError(error, a.path);
      const after = await this.stat(destination, signal);
      return {
        sourceBefore: text,
        destination: {
          operation: 'create',
          version: /** @type {FsVersion} */ (after?.version ?? FsVersion('sftp:unknown')),
          before: null,
          after: content,
        },
        sourceDeleted: false,
        sourceFailure: { code: failed.code, message: failed.message },
      };
    }
    const after = await this.stat(destination, signal);
    return {
      sourceBefore: text,
      destination: {
        operation: 'create',
        version: /** @type {FsVersion} */ (after?.version ?? FsVersion('sftp:unknown')),
        before: null,
        after: content,
      },
      sourceDeleted: true,
    };
  }

  /**
   * Watching a remote path is unsupported: SFTP has no inotify.
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - target to observe.
   * @param {(error?: Error) => void} changed - invalidation callback.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<() => Promise<void>>} the close function for local targets.
   */
  /**
   * Observe a remote target by POLLING it over SFTP.
   *
   * SFTP has no inotify equivalent, and OpenSSH offers no portable change
   * channel, so a remote watcher can only sample. That trade is explicit and
   * configurable:
   *
   * - `watchIntervalMs` (plugin config) controls the sample period; `0` restores
   *   the strict behaviour of rejecting the request.
   * - A sample is one `stat` for a file and one `readdir` for a directory, so the
   *   steady-state cost is one round-trip per interval per watched target. Watch
   *   many targets and this multiplies — keep the interval generous.
   * - Invalidations are reported through `changed` only when the observed
   *   version (or the directory's name set) actually differs, so a quiet target
   *   produces no callbacks.
   *
   * Consumers that need kernel-grade fidelity for remote files should poll on
   * their own or use a mounted filesystem instead.
   * @param {import('@deepseek-ai/dsh-fs').FsTarget} target - target to observe.
   * @param {(error?: Error) => void} changed - invalidation callback.
   * @param {AbortSignal} signal - cancels watcher initialization.
   * @returns {Promise<() => Promise<void>>} resolves once sampling is active, with an async close.
   */
  async watch(target, changed, signal) {
    const { alias, path } = decodeKey(String(target.targetKey));
    if (alias === undefined) return await super.watch(target, changed, signal);

    const intervalMs = typeof this.watchIntervalMs === 'number' ? this.watchIntervalMs : 3000;
    if (intervalMs <= 0) {
      throw new FsError(
        'Watching a remote SSH path needs polling; enable watchIntervalMs to allow it.',
        'FS_IO_ERROR',
      );
    }
    signal?.throwIfAborted();

    const sample = async () => {
      const sftp = await this.registry.get(alias).sftp();
      try {
        const stats = await call(sftp, 'stat', path);
        if (stats.isDirectory()) {
          const entries = await call(sftp, 'readdir', path);
          return `dir:${entries.map((e) => `${e.filename}:${e.attrs.size}:${e.attrs.mtime}`).sort().join('|')}`;
        }
        return `file:${String(versionOf(stats))}`;
      } catch (error) {
        if (/** @type {{code?: number}} */ (error)?.code === SFTP_NO_SUCH_FILE) return 'absent';
        throw sftpError(error, path);
      }
    };

    let baseline = await sample();
    let closed = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** Guards against overlapping samples when a round-trip outlives the period. */
    let polling = false;

    const tick = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        const next = await sample();
        if (closed) return;
        if (next !== baseline) {
          baseline = next;
          changed();
        }
      } catch (error) {
        if (!closed) changed(/** @type {Error} */ (error));
      } finally {
        polling = false;
      }
    };

    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();

    return async () => {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }

  /**
   * Read a remote file, returning null when it is absent.
   * @param {string} alias - route alias.
   * @param {string} path - remote path.
   * @returns {Promise<Buffer | null>} the content or null.
   */
  async _readIfPresent(alias, path) {
    const sftp = await this.registry.get(alias).sftp();
    try {
      await call(sftp, 'stat', path);
    } catch (error) {
      if (/** @type {{code?: number}} */ (error)?.code === SFTP_NO_SUCH_FILE) return null;
      throw sftpError(error, path);
    }
    return await this._readAll(alias, path);
  }

  /**
   * Write a whole remote file through a temp sibling then rename, so readers
   * never observe a partial file.
   * @param {string} alias - route alias.
   * @param {string} path - destination.
   * @param {Buffer} content - bytes to write.
   * @returns {Promise<void>} resolves after the rename.
   */
  async _writeAll(alias, path, content) {
    const sftp = await this.registry.get(alias).sftp();
    const dir = posixPath.dirname(path);
    const temp = `${dir}/.${basename(path)}.dsh-route-${process.pid}-${Date.now()}`;
    await new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(temp, { flags: 'w' });
      stream.on('error', (error) => reject(sftpError(error, temp)));
      stream.on('close', () => resolve(undefined));
      stream.end(content);
    });
    try {
      // SFTP's plain rename does not overwrite on every server, so publish by
      // removing the old entry first. The temp sibling keeps the window small
      // and readers never observe a partially written file.
      await call(sftp, 'unlink', path).catch((error) => {
        if (/** @type {{code?: number}} */ (error)?.code !== SFTP_NO_SUCH_FILE) throw error;
      });
      await call(sftp, 'rename', temp, path);
    } catch (error) {
      await call(sftp, 'unlink', temp).catch(() => undefined);
      throw sftpError(error, path);
    }
  }
}

export default RoutedFileSystem;
