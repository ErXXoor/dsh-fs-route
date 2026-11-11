/*!
 * dsh-fs-route — browser half.
 *
 * Served to the page as a classic script and executed at boot. It only
 * REGISTERS a factory; every side effect (including the stylesheet) lives in
 * the closure and runs at materialization, which is the client module system's
 * lazy-CJS contract.
 *
 * Fills the two workspace "directory flow" holes `ui-workspace` declares. That
 * package owns the "Add workspace…" trigger and the adoption step
 * (`createWorkspace({ path })`); this occupant owns everything between `open`
 * and the picked path. Picking a remote directory hands back
 * `ssh://<alias>/<abs path>`, which the routed providers consume.
 */
(function () {
  'use strict';

  var loader = window.__ModuleLoader__;
  if (loader === undefined) {
    console.error('[dsh-fs-route] module loader missing; browser half not registered');
    return;
  }

  var ROUTE = '/api/dsh-fs-route';

  /** Call one browse action on the host. */
  function call(action, payload) {
    var init = payload === undefined
      ? { method: 'GET' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        };
    return fetch(ROUTE + '/' + action, init).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) {
          var message = body && typeof body.message === 'string' ? body.message : 'request failed (' + response.status + ')';
          throw new Error(message);
        }
        return body;
      });
    });
  }

  var CSS = [
    '.dshfsr-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);font:13px/1.45 system-ui,sans-serif}',
    '.dshfsr-panel{width:min(560px,92vw);max-height:76vh;display:flex;flex-direction:column;gap:8px;padding:14px;border-radius:10px;background:var(--color-surface,var(--vscode-editor-background,#fff));color:inherit;box-shadow:0 10px 40px rgba(0,0,0,.28);border:1px solid var(--color-border,rgba(128,128,128,.28))}',
    '.dshfsr-title{font-weight:600;font-size:14px}',
    '.dshfsr-select{padding:5px 6px;border-radius:6px;border:1px solid var(--color-border,rgba(128,128,128,.35));background:transparent;color:inherit}',
    '.dshfsr-path{display:flex;gap:6px;align-items:center;font-family:ui-monospace,monospace;font-size:12px;opacity:.85;overflow:hidden}',
    '.dshfsr-crumb{border:1px solid var(--color-border,rgba(128,128,128,.35));background:transparent;color:inherit;border-radius:5px;padding:1px 6px;cursor:pointer}',
    '.dshfsr-crumb-current{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dshfsr-list{flex:1;overflow:auto;border:1px solid var(--color-border,rgba(128,128,128,.28));border-radius:8px;min-height:180px}',
    '.dshfsr-row{display:block;width:100%;text-align:left;padding:5px 9px;background:none;border:0;color:inherit;font:inherit;cursor:pointer}',
    '.dshfsr-row:hover:not(:disabled){background:var(--color-hover,rgba(128,128,128,.14))}',
    '.dshfsr-row:disabled{opacity:.45;cursor:default}',
    '.dshfsr-dir{font-weight:500}',
    '.dshfsr-loading{padding:8px 9px;opacity:.6}',
    '.dshfsr-error{padding:6px 8px;border-radius:6px;background:rgba(220,80,80,.14);color:inherit}',
    '.dshfsr-actions{display:flex;justify-content:flex-end;gap:8px}',
    '.dshfsr-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--color-border,rgba(128,128,128,.35));background:transparent;color:inherit;cursor:pointer;font:inherit}',
    '.dshfsr-btn:disabled{opacity:.5;cursor:default}',
    '.dshfsr-primary{background:var(--color-primary,#4a6cf7);border-color:transparent;color:var(--color-primary-fg,#fff)}',
    '.dshfsr-tabs{display:flex;gap:6px}',
    '.dshfsr-tab{padding:4px 10px;border-radius:6px;border:1px solid transparent;background:transparent;color:inherit;opacity:.7;cursor:pointer;font:inherit}',
    '.dshfsr-tab:hover{opacity:1;background:var(--color-hover,rgba(128,128,128,.14))}',
    '.dshfsr-tab-active{opacity:1;border-color:var(--color-border,rgba(128,128,128,.35));background:var(--color-hover,rgba(128,128,128,.14))}',
  ].join('\n');

  loader.load({
    id: 'dsh-fs-route',
    factory: function (require) {
      var React = require('react');
      var h = React.createElement;

      function ensureStyles() {
        if (typeof document === 'undefined') return;
        if (document.getElementById('dsh-fs-route-styles') !== null) return;
        var style = document.createElement('style');
        style.id = 'dsh-fs-route-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
      }

      /**
       * The workspace picker rendered into a directory-flow hole.
       *
       * It offers BOTH worlds. Taking this `single` hole for SSH also switches
       * off the shipped native chooser, so without a local branch the operator
       * could no longer add a local folder at all — a real capability loss, not
       * an acceptable trade. The default tab follows the configuration: hosts
       * present means this deployment exists for remote work.
       */
      function WorkspaceFlow(props) {
        var open = props.open;
        var busy = props.busy;
        var onPicked = props.onPicked;
        var onCancel = props.onCancel;
        var onError = props.onError;

        var modeState = React.useState(null);
        var mode = modeState[0];
        var setMode = modeState[1];
        var aliasState = React.useState(null);
        var alias = aliasState[0];
        var setAlias = aliasState[1];
        var pathState = React.useState('');
        var path = pathState[0];
        var setPath = pathState[1];
        var parentState = React.useState(null);
        var parent = parentState[0];
        var setParent = parentState[1];
        var homeState = React.useState('');
        var home = homeState[0];
        var setHome = homeState[1];
        var entryState = React.useState([]);
        var entries = entryState[0];
        var setEntries = entryState[1];
        var listState = React.useState([]);
        var hosts = listState[0];
        var setHosts = listState[1];
        var loadingState = React.useState(false);
        var loading = loadingState[0];
        var setLoading = loadingState[1];
        var errState = React.useState('');
        var error = errState[0];
        var setError = errState[1];
        var commitState = React.useState(false);
        var committing = commitState[0];
        var setCommitting = commitState[1];
        // A directory tree cannot cross a volume, so the local tab gets an
        // explicit "Drives" level: walking up from C:\ stops at the root.
        var rootState = React.useState(null);
        var roots = rootState[0];
        var setRoots = rootState[1];

        // Load hosts when the flow opens, then pick the starting tab.
        React.useEffect(function () {
          if (!open) return undefined;
          var cancelled = false;
          call('hosts').then(function (body) {
            if (cancelled) return;
            var list = Array.isArray(body.hosts) ? body.hosts : [];
            setHosts(list);
            if (list.length > 0) setAlias(function (current) { return current === null ? list[0].alias : current; });
            setMode(function (current) { return current === null ? (list.length > 0 ? 'ssh' : 'local') : current; });
          }).catch(function (e) { if (!cancelled) setError(e.message); });
          return function () { cancelled = true; };
        }, [open]);

        // Volume mounts, for the local tab's "Drives" level.
        React.useEffect(function () {
          if (!open) return undefined;
          var cancelled = false;
          call('local/roots').then(function (body) {
            if (cancelled) return;
            setRoots(Array.isArray(body.roots) ? body.roots : []);
            // Home is needed for the `~` shortcut while sitting on the synthetic
            // Drives level, which never calls the directory listing.
            if (typeof body.home === 'string' && body.home !== '') setHome(body.home);
          }).catch(function () { if (!cancelled) setRoots([]); });
          return function () { cancelled = true; };
        }, [open]);

        // Browse the active world. `path` is the authoritative cursor: the
        // server normalizes it and reports the parent, so no client-side path
        // arithmetic can disagree with the host's separators.
        React.useEffect(function () {
          if (!open || mode === null) return undefined;
          if (mode === 'ssh' && alias === null) return undefined;
          // An empty local path is the synthetic "Drives" level, not a directory:
          // it renders from the volume list and must not be normalized to home
          // (which would make the level unreachable).
          if (mode === 'local' && path === '') {
            setEntries([]);
            setParent(null);
            setError('');
            setLoading(false);
            return undefined;
          }
          var cancelled = false;
          setLoading(true);
          setError('');
          var request = mode === 'ssh'
            ? call('list', { alias: alias, path: path })
            : call('local/list', { path: path });
          request.then(function (body) {
            if (cancelled) return;
            setPath(typeof body.path === 'string' ? body.path : '');
            setParent(typeof body.parent === 'string' ? body.parent : null);
            setHome(typeof body.home === 'string' ? body.home : '');
            setEntries(Array.isArray(body.entries) ? body.entries : []);
          }).catch(function (e) {
            if (!cancelled) setError(e.message);
          }).then(function () {
            if (!cancelled) setLoading(false);
          });
          return function () { cancelled = true; };
        }, [open, mode, alias, path]);

        if (!open) return null;

        var canUse = path !== '' && (mode === 'local' || alias !== null);
        var rows = [];
        // Local tab: the "Drives" level replaces the directory listing, so the
        // operator can cross to another volume that ".." can never reach.
        var showingRoots = mode === 'local' && path === '';
        if (showingRoots) {
          (roots ?? []).forEach(function (root) {
            rows.push(h('button', {
              key: 'root-' + root.path,
              type: 'button',
              className: 'dshfsr-row dshfsr-dir',
              onClick: function () { setPath(root.path); },
            }, root.name));
          });
          if (rows.length === 0) rows.push(h('div', { key: '__noroots', className: 'dshfsr-loading' }, 'No volumes reported'));
        }
        if (parent !== null && !showingRoots) {
          rows.push(h('button', {
            key: '..',
            type: 'button',
            className: 'dshfsr-row',
            onClick: function () { setPath(parent); },
          }, '..'));
        }
        entries.forEach(function (entry) {
          if (showingRoots) return;
          rows.push(h('button', {
            key: entry.name,
            type: 'button',
            className: 'dshfsr-row dshfsr-dir',
            // The host sends each child's full path, so this component never
            // does separator arithmetic for a world it does not own.
            onClick: function () { setPath(entry.path); },
          }, entry.name + '/'));
        });
        if (loading) rows.push(h('div', { key: '__loading', className: 'dshfsr-loading' }, 'Loading\u2026'));

        var tabs = h('div', { className: 'dshfsr-tabs' },
          ['ssh', 'local'].map(function (kind) {
            if (kind === 'ssh' && hosts.length === 0) return null;
            return h('button', {
              key: kind,
              type: 'button',
              className: 'dshfsr-tab' + (mode === kind ? ' dshfsr-tab-active' : ''),
              onClick: function () { setMode(kind); setPath(''); setEntries([]); setError(''); },
            }, kind === 'ssh' ? 'SSH host' : 'Local folder');
          }),
        );

        return h('div', { role: 'dialog', 'aria-label': 'Add workspace', className: 'dshfsr-overlay' },
          h('div', { className: 'dshfsr-panel' },
            h('div', { className: 'dshfsr-title' }, mode === 'ssh' ? 'Add SSH workspace' : 'Add local workspace'),
            tabs,
            mode === 'ssh' && hosts.length > 1
              ? h('select', {
                  className: 'dshfsr-select',
                  value: alias === null ? '' : alias,
                  onChange: function (event) { setAlias(event.target.value); setPath(''); },
                }, hosts.map(function (host) {
                  return h('option', { key: host.alias, value: host.alias }, host.alias + ' (' + host.endpoint + ')');
                }))
              : null,
            h('div', { className: 'dshfsr-path' },
              mode === 'local'
                ? h('button', {
                    type: 'button',
                    className: 'dshfsr-crumb',
                    onClick: function () { setPath(''); },
                    title: 'Show drives',
                  }, 'Drives')
                : null,
              home !== '' && mode === 'local'
                ? h('button', { type: 'button', className: 'dshfsr-crumb', onClick: function () { setPath(home); } }, '~')
                : null,
              home !== '' && mode === 'ssh'
                ? h('button', { type: 'button', className: 'dshfsr-crumb', onClick: function () { setPath(home); } }, '~')
                : null,
              h('span', { className: 'dshfsr-crumb-current' }, path === '' ? 'Drives' : path),
            ),
            error !== '' ? h('div', { className: 'dshfsr-error' }, error) : null,
            h('div', { className: 'dshfsr-list' }, rows),
            h('div', { className: 'dshfsr-actions' },
              h('button', { type: 'button', className: 'dshfsr-btn', onClick: onCancel, disabled: busy === true }, 'Cancel'),
              h('button', {
                type: 'button',
                className: 'dshfsr-btn dshfsr-primary',
                disabled: busy === true || committing === true || !canUse,
                onClick: function () {
                  if (!canUse) return;
                  if (mode === 'local') {
                    // A local directory is already an absolute host path.
                    onPicked(path);
                    return;
                  }
                  // Remote hands back a host-shaped placeholder, not `ssh://`:
                  // the workspace controller validates with `path.isAbsolute`,
                  // which is false for `ssh://` on Windows.
                  setCommitting(true);
                  call('route', { alias: alias, path: path }).then(function (body) {
                    setCommitting(false);
                    if (typeof body.cwd === 'string' && body.cwd !== '') onPicked(body.cwd);
                    else onError('host did not return a workspace path');
                  }).catch(function (e) {
                    setCommitting(false);
                    onError(e.message);
                  });
                },
              }, busy === true || committing === true ? 'Adding\u2026' : 'Use this folder'),
            ),
          ),
        );
      }

      function Flow(props) {
        ensureStyles();
        return h(WorkspaceFlow, props);
      }

      return {
        inject: ['slots'],
        apply: function (ctx) {
          // Both surfaces declare an independent hole; one occupant fills both.
          // `priority` (not `order`) is the field the slot registry reads; a
          // second registration at the SAME priority fails the later entry and
          // aborts web boot, so keep off the default 0.
          ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'].forEach(function (name) {
            ctx.slots.inject(name, function () {
              return ctx.slots.register({ name: name, id: 'dsh-fs-route', priority: 10 }, Flow);
            });
          });
        },
      };
    },
  });
})();
