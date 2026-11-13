/**
 * dsh-fs-route — workspace-routed execution worlds for DeepSeek Harness.
 *
 * `ctx.fs` and `ctx.subprocess` are single-slot services, so the shipped SSH
 * providers can only swap the *entire* execution world: every session in a
 * composition moves to the remote host, and any local workspace breaks (a local
 * Windows path gets `stat`-ed on the Linux server). This plugin keeps one slot
 * and routes *per operation*:
 *
 *   - local sessions keep the real local filesystem and local commands
 *   - `ssh://<alias>/<path>` sessions read, write and execute on the server
 *
 * Both providers extend their shipped local counterparts and delegate every
 * non-routed operation to `super.*`, mirroring how `dsh-fs-sandbox` decorates
 * `dsh-fs-local`. Local behaviour is therefore the shipped implementation's,
 * unmodified and with no synthetic instances.
 *
 * @module dsh-fs-route
 */
import { RoutedFileSystem } from './fs.js';
import { RoutedSubprocessRuntime } from './subprocess.js';
import { SshRegistry } from './ssh.js';

export { RoutedFileSystem } from './fs.js';
export { RoutedSubprocessRuntime } from './subprocess.js';
export { SshRegistry } from './ssh.js';
export { parseSshRoute, isSshRoute, encodeKey, decodeKey } from './route.js';
export { registerWorkspaceRoutes, ROUTE_PREFIX } from './web.js';

/** Marker so the loader sees this module as a plugin with an `apply` body. */
export const name = 'dsh-fs-route';

/**
 * Mount the routed filesystem and subprocess providers.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the mounting context.
 * @param {object} config - plugin configuration.
 * @param {Record<string, object>} [config.hosts] - alias to connection settings.
 * @param {string} [config.defaultHost] - alias for bare POSIX paths.
 * @param {object} [config.fs] - local filesystem configuration (cwd, limits).
 */
export function apply(ctx, config = {}) {
  const settings = config ?? {};
  const registry = new SshRegistry(settings.hosts ?? {});
  ctx.effect(() => () => registry.dispose());

  ctx.plugin(RoutedFileSystem, {
    config: settings.fs ?? {},
    deps: {
      registry,
      defaultHost: settings.defaultHost,
      // 0 disables remote watching (the strict, no-polling behaviour).
      watchIntervalMs: settings.watchIntervalMs ?? 3000,
    },
  });
  ctx.plugin(RoutedSubprocessRuntime, {
    deps: { registry },
  });

  // `ctx.shell` is a single slot and the request carries no dialect field, so
  // the platform's own sandbox executor keeps the slot and only diverts routed
  // working directories to the SSH host. Local commands therefore keep their
  // real semantics (Windows: pwsh) while a remote session runs POSIX.
  //
  // This bundle's patch turns the shipped shell rows OFF, so whatever happens
  // here the slot MUST end up occupied: an empty `shell` leaves `permission`,
  // `tool-bash` and `tool-pwsh` permanently pending. A failed import therefore
  // falls back to a self-contained executor instead of just logging.
  // The candidate list matters: the realistic failure is ONE package missing
  // from a given harness build, not the whole shell stack. Trying the sandbox
  // executor and then its plain local base (which shares the same argv and
  // result semantics) recovers with a real executor instead of a substitute.
  const candidates = [
    ...(settings.shell?.base !== undefined ? [settings.shell.base] : []),
    ...(process.platform === 'win32'
      ? ['@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-pwsh-local']
      : ['@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-bash-local']),
  ];
  void (async () => {
    /** @type {string[]} */
    const failures = [];
    for (const specifier of candidates) {
      try {
        const mod = await import(specifier);
        const Base = mod.default ?? mod.SandboxPwshExecutor ?? mod.SandboxBashExecutor
          ?? mod.PwshLocalExecutor ?? mod.LocalBashExecutor;
        if (typeof Base !== 'function') throw new Error('no usable executor export');
        const { makeRoutedShell } = await import('./shell.js');
        ctx.plugin(makeRoutedShell(Base, registry), settings.shell?.config ?? {});
        if (failures.length > 0) {
          console.error(`[dsh-fs-route] shell base ${specifier} used after: ${failures.join('; ')}`);
        }
        return;
      } catch (error) {
        failures.push(`${specifier}: ${error?.message ?? error}`);
      }
    }
    console.error(`[dsh-fs-route] no shipped shell executor could be imported (${failures.join('; ')}); using the built-in fallback`);
    try {
      const { makeFallbackShell } = await import('./shell.js');
      const Fallback = await makeFallbackShell();
      ctx.plugin(Fallback, registry);
    } catch (error) {
      // Last resort: say exactly which rows to restore. Leaving this silent is
      // what turns a missing optional import into an unusable profile.
      console.error(
        '[dsh-fs-route] FATAL: no shell executor could be mounted, so `ctx.shell` is missing.\n'
        + `  cause: ${error?.message ?? error}\n`
        + '  recovery: remove "dsh-fs-route" from dsh.profile.bundles in the profile package.json, OR\n'
        + '            re-enable the `pwsh-sandbox` and `bash-sandbox` rows in the profile cordis.patch.yml.',
      );
    }
  })();

  // The browse surface the client picker dialog calls. Registered only where a
  // web carrier exists, so headless compositions mount without it.
  ctx.inject?.(['webServer'], (webCtx) => {
    void import('./web.js').then(
      (mod) => mod.registerWorkspaceRoutes(webCtx, settings, registry),
      (error) => console.error('[dsh-fs-route] browse routes unavailable:', error?.message ?? error),
    );
  });
}
