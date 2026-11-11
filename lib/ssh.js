/**
 * SSH connection pool and remote primitives for dsh-fs-route.
 *
 * One lazily opened, long-lived connection per alias. Windows' OpenSSH has no
 * connection multiplexing, so a resident ssh2 client is the only way to keep
 * per-call latency near the network RTT instead of paying a process handshake
 * on every tool call.
 *
 * @module dsh-fs-route/ssh
 */
import { Client } from 'ssh2';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Raised when a route names an alias the connection registry does not know. */
export class UnknownAliasError extends Error {
  /**
   * @param {string} alias - the unknown alias.
   */
  constructor(alias) {
    super(`dsh-fs-route: unknown ssh alias ${JSON.stringify(alias)}`);
    this.name = 'UnknownAliasError';
  }
}

/**
 * Expand `~`, resolve a relative identity path against `~/.ssh`, and read it.
 * @param {string} spec - configured private key path or inline PEM.
 * @returns {Buffer} the key material.
 */
function loadPrivateKey(spec) {
  if (spec.includes('-----BEGIN')) return Buffer.from(spec, 'utf8');
  let p = spec;
  if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  return readFileSync(p);
}

/**
 * One alias's connection settings.
 * @typedef {object} AliasConfig
 * @property {string} host - hostname or address.
 * @property {number} [port] - SSH port, default 22.
 * @property {string} username - login user.
 * @property {string} [privateKey] - path or inline PEM.
 * @property {string} [password] - password authentication.
 * @property {string} [passphrase] - key passphrase.
 * @property {string} [agent] - agent socket.
 * @property {number} [readyTimeout] - connect timeout, ms.
 * @property {number} [keepaliveInterval] - keepalive interval, ms; 0 disables.
 * @property {number} [keepaliveCountMax] - keepalive retry budget.
 * @property {string} [cwd] - default remote directory for this alias.
 * @property {boolean} [strictHostKeyChecking] - verify the host key.
 * @property {string[]} [knownHosts] - accepted host keys.
 */

/**
 * A shared SSH connection with lazy client and SFTP channel.
 */
export class SshConnection {
  /** @type {import('ssh2').Client | undefined} */
  #client;
  /** @type {Promise<import('ssh2').Client> | undefined} */
  #opening;
  /** @type {import('ssh2').SFTPWrapper | undefined} */
  #sftp;
  /** @type {Promise<import('ssh2').SFTPWrapper> | undefined} */
  #sftpOpening;
  /** @type {Record<string, string> | undefined} */
  #env;

  /**
   * @param {string} alias - the registry alias this connection belongs to.
   * @param {AliasConfig} config - connection settings.
   */
  constructor(alias, config) {
    this.alias = alias;
    this.config = config;
  }

  /** Human-readable `user@host` for diagnostics and display. */
  get endpoint() {
    return `${this.config.username}@${this.config.host}`;
  }

  /** The alias's configured default remote directory. */
  get cwd() {
    return this.config.cwd ?? '/';
  }

  /**
   * The live authenticated client, connecting on first use.
   * @param {AbortSignal} [signal] - cancels the connection attempt.
   * @returns {Promise<import('ssh2').Client>} the authenticated client.
   */
  async client(signal) {
    if (this.#client !== undefined) return this.#client;
    if (this.#opening === undefined) {
      this.#opening = this.#open(this.config).then(
        (client) => {
          this.#client = client;
          client.on('close', () => {
            this.#client = undefined;
            this.#sftp = undefined;
            this.#sftpOpening = undefined;
          });
          return client;
        },
        (error) => {
          this.#opening = undefined;
          throw error;
        },
      );
    }
    const client = await this.#opening;
    signal?.throwIfAborted();
    return client;
  }

  /**
   * Open and authenticate one connection.
   * @param {AliasConfig} config - connection settings.
   * @returns {Promise<import('ssh2').Client>} the ready client.
   */
  #open(config) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      client.on('ready', () => done(resolve, client));
      client.on('error', (error) => done(reject, error));
      client.on('close', () => done(reject, new Error(`dsh-fs-route: ssh connection to ${config.host} closed before ready`)));

      /** @type {Record<string, unknown>} */
      const options = {
        host: config.host,
        port: config.port ?? 22,
        username: config.username,
        readyTimeout: config.readyTimeout ?? 20000,
        keepaliveInterval: config.keepaliveInterval ?? 15000,
        keepaliveCountMax: config.keepaliveCountMax ?? 4,
      };
      if (config.privateKey !== undefined) options.privateKey = loadPrivateKey(config.privateKey);
      if (config.password !== undefined) options.password = config.password;
      if (config.passphrase !== undefined) options.passphrase = config.passphrase;
      if (config.agent !== undefined) options.agent = config.agent;
      if (config.strictHostKeyChecking === true) {
        options.hostVerifier = (hashedKey) =>
          (config.knownHosts ?? []).some((known) => known.includes(hashedKey) || hashedKey.includes(known));
      }
      try {
        client.connect(options);
      } catch (error) {
        done(reject, error);
      }
    });
  }

  /**
   * The shared SFTP channel, opened lazily once per connection.
   * @param {AbortSignal} [signal] - cancels the channel open.
   * @returns {Promise<import('ssh2').SFTPWrapper>} the SFTP wrapper.
   */
  async sftp(signal) {
    if (this.#sftp !== undefined) return this.#sftp;
    if (this.#sftpOpening === undefined) {
      this.#sftpOpening = (async () => {
        const client = await this.client(signal);
        return await new Promise((resolve, reject) => {
          client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
        });
      })().then(
        (sftp) => {
          this.#sftp = sftp;
          return sftp;
        },
        (error) => {
          this.#sftpOpening = undefined;
          throw error;
        },
      );
    }
    return await this.#sftpOpening;
  }

  /**
   * The remote login environment, read once per connection and cached. The
   * remote shell is a login shell, so this also yields the user's PATH.
   * @param {AbortSignal} [signal] - cancels the probe.
   * @returns {Promise<Record<string, string>>} environment entries.
   */
  async environment(signal) {
    if (this.#env !== undefined) return this.#env;
    const outcome = await this.exec('env -0', { signal });
    /** @type {Record<string, string>} */
    const env = {};
    for (const entry of outcome.stdout.split('\u0000')) {
      if (entry === '') continue;
      const eq = entry.indexOf('=');
      if (eq <= 0) continue;
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    this.#env = env;
    return env;
  }

  /**
   * Run one control-plane command with collected output.
   * @param {string} command - command text, already quoted by the caller.
   * @param {{cwd?: string, signal?: AbortSignal}} [opts] - working directory and cancellation.
   * @returns {Promise<{exitCode: number | null, stdout: string, stderr: string}>} collected outcome.
   */
  async exec(command, opts = {}) {
    const client = await this.client(opts.signal);
    const text = opts.cwd === undefined ? command : `cd ${quote(opts.cwd)} && ${command}`;
    return await new Promise((resolve, reject) => {
      // The working directory rides in the command text, not in ssh2's exec
      // options: a login shell start directory is not honored by every server,
      // and `cd` makes the intent explicit and portable.
      client.exec(text, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        stream.on('close', (code) => resolve({ exitCode: code ?? null, stdout, stderr }));
        stream.on('error', reject);
      });
    });
  }

  /** Close the connection and its cached channel state. */
  dispose() {
    const client = this.#client;
    this.#client = undefined;
    this.#sftp = undefined;
    this.#sftpOpening = undefined;
    this.#env = undefined;
    client?.end();
  }
}

/**
 * Quote one argument for a POSIX login shell.
 * @param {string} value - exact argument value to preserve.
 * @returns {string} a single shell word with no interpolation.
 */
export function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the alias registry from configuration.
 *
 * Each entry is its own connection; a route selects one by alias.
 */
export class SshRegistry {
  /** @type {Map<string, SshConnection>} */
  #connections = new Map();

  /**
   * @param {Record<string, AliasConfig>} configs - alias to settings.
   */
  constructor(configs) {
    for (const [alias, config] of Object.entries(configs)) {
      this.#connections.set(alias, new SshConnection(alias, config));
    }
  }

  /**
   * Look up one alias's connection.
   * @param {string} alias - the alias named by a route.
   * @returns {SshConnection} the connection.
   * @throws {UnknownAliasError} when the alias is not configured.
   */
  get(alias) {
    const connection = this.#connections.get(alias);
    if (connection === undefined) {
      // Route parsing filters placeholders by alias membership, so reaching here
      // means a caller named an alias explicitly (an `ssh://` spelling) or the
      // configuration is missing one — both deserve a loud failure.
      console.error(`[dsh-fs-route] unknown ssh alias ${JSON.stringify(alias)}; configured: ${this.aliases.join(', ') || '(none)'}`);
      throw new UnknownAliasError(alias);
    }
    return connection;
  }

  /** Configured aliases. */
  get aliases() {
    return [...this.#connections.keys()];
  }

  /**
   * Whether an alias is configured. Route parsing uses this to tell a real
   * placeholder path from an unrelated host path that merely sits under the
   * placeholder root (project-root discovery probes `<root>/.git`).
   * @param {string} alias - candidate alias.
   * @returns {boolean} true when configured.
   */
  has(alias) {
    return this.#connections.has(alias);
  }

  /** Close every connection. */
  dispose() {
    for (const connection of this.#connections.values()) connection.dispose();
    this.#connections.clear();
  }
}

/**
 * Whether a configured value looks like an inline PEM rather than a path.
 * @param {string} value - configured private key value.
 * @returns {boolean} true for inline key material.
 */
export function isInlineKey(value) {
  return value.includes('-----BEGIN');
}

export { isAbsolute };
