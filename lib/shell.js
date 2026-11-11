/**
 * Workspace-routed `ctx.shell`.
 *
 * `ctx.shell` is a single slot and the request carries no dialect field, so a
 * Windows composition can only have ONE shell flavor. That is fine as long as
 * the slot dispatches per call on the working directory:
 *
 *   - local workdir  -> the shipped platform executor (`super`), so the local
 *     pwsh/bash tool keeps its real semantics, sandbox included
 *   - routed workdir -> `bash -c` on the SSH host, through the routed
 *     `ctx.subprocess` provider (which owns the SSH transport)
 *
 * A remote Linux host has no PowerShell, so routed commands are always sent to
 * a POSIX shell regardless of which tool invoked them.
 *
 * @module dsh-fs-route/shell
 */
import { parseAnyRoute } from './route.js';

/**
 * Collected-stream shim matching `ShellObservedStreams` / `CollectedOutput`
 * closely enough for the tool layer: offset reads never consume, and the
 * settled projection reports the whole retained text.
 */
class Streams {
  /** @param {number} maxBytes - in-memory cap; overflow keeps the tail. */
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    /** @type {string} */
    this.text = '';
    /** @type {number} */
    this.dropped = 0;
  }

  /**
   * Append one decoded chunk.
   * @param {string} chunk - text.
   */
  push(chunk) {
    this.text += chunk;
    while (Buffer.byteLength(this.text, 'utf8') > this.maxBytes && this.text.length > 0) {
      const cut = Math.ceil(this.text.length / 8);
      this.text = this.text.slice(cut);
      this.dropped += cut;
    }
  }

  /** Offset reader over the retained text. */
  get reader() {
    const self = this;
    return {
      /**
       * @param {number} from - resume offset.
       * @returns {{text: string, nextOffset: number, lossy: boolean}} the read.
       */
      readFrom(from) {
        const lossy = from < self.dropped;
        const text = lossy ? self.text : self.text.slice(Math.max(0, from - self.dropped));
        return { text, nextOffset: self.dropped + self.text.length, lossy };
      },
    };
  }

  /** The `CollectedOutput` projection. */
  get collected() {
    return { text: this.text, truncated: this.dropped > 0 };
  }
}

/**
 * Build the remote half of one execution. It mirrors the observable contract of
 * the shipped executors: a live `ShellProcess` plus a memoized `result()`.
 * @param {object} deps - collaborators.
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessRuntime} deps.subprocess - the routed subprocess provider.
 * @param {object} spec - fully resolved spec.
 * @param {number} graceMs - termination grace.
 * @param {number} timeoutMs - effective deadline; 0 arms none.
 * @returns {import('@deepseek-ai/dsh-shell').ShellExecution} the execution handle.
 */
function remoteExecution(deps, spec, graceMs, timeoutMs) {
  const stdoutMax = typeof spec.stdoutMaxBytes === 'number' ? spec.stdoutMaxBytes : 64 * 1024;
  const stderrMax = 64 * 1024;
  const out = new Streams(stdoutMax);
  const err = new Streams(stderrMax);

  const controller = new AbortController();
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  let timedOut = false;
  let aborted = false;

  if (spec.signal !== undefined) {
    if (spec.signal.aborted) {
      aborted = true;
      controller.abort();
    } else {
      spec.signal.addEventListener('abort', () => {
        aborted = true;
        controller.abort();
      }, { once: true });
    }
  }
  if (timeoutMs > 0 && spec.onExpiry !== 'none') {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
  }

  let handle;
  try {
    handle = deps.subprocess.spawn({
      argv: ['bash', '-c', spec.command],
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
        stdout: { maxBytes: stdoutMax },
        stderr: { maxBytes: stderrMax },
      },
      graceMs,
      signal: controller.signal,
      env: spec.env,
    });
  } catch (error) {
    // A synchronous spawn failure still has to produce a handle: the tool layer
    // reads `result()` for the story.
    const message = /** @type {Error} */ (error)?.message ?? String(error);
    err.push(message);
    const settled = Promise.resolve({
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs,
      stdout: out.collected,
      stderr: err.collected,
    });
    return {
      status: /** @type {const} */ ('killed'),
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
      readOutput: () => ({ delta: message, lossy: false }),
      observed: { stdout: out.reader, stderr: err.reader },
      kill: () => false,
      result: () => settled,
    };
  }

  // Drain the provider's collected readers into our own buffers.
  let cursorOut = 0;
  let cursorErr = 0;
  const drain = () => {
    const so = handle.collected?.stdout?.readFrom(cursorOut);
    if (so !== undefined) {
      cursorOut = so.nextOffset;
      if (so.text !== '') out.push(so.text);
    }
    const se = handle.collected?.stderr?.readFrom(cursorErr);
    if (se !== undefined) {
      cursorErr = se.nextOffset;
      if (se.text !== '') err.push(se.text);
    }
  };

  let consumed = 0;
  const settle = handle.done.then(
    (outcome) => {
      drain();
      if (timer !== undefined) clearTimeout(timer);
      return {
        exitCode: outcome?.exitCode ?? null,
        signal: outcome?.signal ?? null,
        timedOut,
        aborted: aborted && !timedOut,
        timeoutMs,
        stdout: out.collected,
        stderr: err.collected,
      };
    },
    (error) => {
      drain();
      if (timer !== undefined) clearTimeout(timer);
      err.push(/** @type {Error} */ (error)?.message ?? String(error));
      throw error;
    },
  );

  const execution = {
    status: /** @type {const} */ ('running'),
    exitCode: null,
    signal: null,
    done: handle.done.then(() => undefined, () => undefined),
    observed: { stdout: out.reader, stderr: err.reader },
    /**
     * Consuming read of output produced since the previous call.
     * @returns {{delta: string, lossy: boolean}} the delta.
     */
    readOutput() {
      drain();
      const all = out.text + (err.text === '' ? '' : '\n[stderr]\n' + err.text);
      const delta = all.slice(consumed);
      consumed = all.length;
      return { delta, lossy: false };
    },
    /**
     * Terminate the remote command.
     * @returns {boolean} true when a running command was signalled.
     */
    kill() {
      try {
        handle.terminate();
        return true;
      } catch {
        return false;
      }
    },
    /**
     * @returns {Promise<import('@deepseek-ai/dsh-shell').ShellRunResult>} the settled projection.
     */
    result: () => settle,
  };

  void settle.then(
    (result) => {
      execution.status = /** @type {const} */ (
        result.signal !== null || result.exitCode === null ? 'killed' : 'completed'
      );
      execution.exitCode = result.exitCode;
      execution.signal = result.signal;
    },
    () => {
      execution.status = /** @type {const} */ ('killed');
    },
  );

  return /** @type {import('@deepseek-ai/dsh-shell').ShellExecution} */ (execution);
}

/**
 * Attach the routing behaviour to one shipped executor base class.
 *
 * The base supplies `resolve()` (defaults and caps), the local sandbox policy
 * plumbing, and the platform's real local execution; this subclass only diverts
 * a routed working directory to the remote host.
 * @param {Function} Base - the platform's sandbox executor class.
 * @param {import('./ssh.js').SshRegistry} registry - alias registry.
 * @returns {Function} the routed executor class.
 */
export function makeRoutedShell(Base, registry) {
  return class RoutedShellExecutor extends Base {
    /**
     * @param {import('@deepseek-ai/cordis').Context} ctx - mounting context.
     * @param {object} config - the base executor config.
     */
    constructor(ctx, config) {
      super(ctx, config);
      this.registry = registry;
    }

    /**
     * Execute one resolved spec, locally or on the SSH host.
     * @param {import('@deepseek-ai/dsh-shell').ShellExecSpec} spec - resolved spec.
     * @returns {Promise<import('@deepseek-ai/dsh-shell').ShellExecution>} the handle.
     */
    async execute(spec) {
      const route = parseAnyRoute(spec.workdir, (alias) => this.registry.has(alias));
      if (route === null) return await super.execute(spec);

      // A routed command has no local fence to apply: the confinement runner is
      // a host binary, so wrapping here would hand a Windows path to the remote
      // shell. The remote world is unfenced by construction.
      const subprocess = /** @type {any} */ (this.ctx).subprocess;
      const graceMs = typeof this.config?.graceMs?.get === 'function' ? this.config.graceMs.get() : 3000;
      const timeoutMs = typeof spec.timeoutMs === 'number' ? spec.timeoutMs : 0;
      return remoteExecution({ subprocess }, spec, graceMs, timeoutMs);
    }
  };
}
