// dsh-multi-api-plugin — Settings card (Key Pools).
//
// Renders in Settings → Plugins → Plugin settings through the `settings.plugin.item`
// slot, which this harness version dispatches per settings namespace (the tab
// enumerates namespaces but never interprets one, so a plugin that ships a browser
// half owns its own card). The registration key must equal the settings namespace.
//
// The card edits the plugin's `dsh-multi-api-plugin` settings namespace through the
// settings scope: reads come from `getSnapshot`/`subscribe`, the write is one
// `set('pools', …)` — the host schema validates it where it is written, so a value
// that is not a credential reference is refused and the refusal text is what the
// user sees. Model-scoped sub-pools (`pools.<REF>.models`) are shown read-only and
// stay a hand-edited setting; the pool-level slot list is what this card edits.
//
// Copy is a static string on purpose: it is resolved while the page renders, and a
// locale lookup there would take the whole client batch down with it.
//
// Delivery contract (matches every shipped client bundle): the served file is the
// body of one lazy CJS registration — `window.__ModuleLoader__.load({id, factory})`,
// where `id` is the package name the host advertises at /plugins/<id>/client.js.
// Nothing runs until the loader materializes the module.

window.__ModuleLoader__.load({
  id: 'dsh-multi-api-plugin',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** The settings namespace this card edits, and its slot registration key. */
    const NS = 'dsh-multi-api-plugin';

    const styles = {
      card: { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0', fontSize: 13 },
      pool: { border: '1px solid rgba(127,127,127,0.35)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 },
      row: { display: 'flex', alignItems: 'center', gap: 6 },
      slot: { display: 'flex', alignItems: 'center', gap: 6 },
      grow: { flex: 1, minWidth: 0 },
      button: { cursor: 'pointer' },
      muted: { opacity: 0.65, fontSize: 12 },
      ok: { color: '#2e9e5b', fontSize: 12 },
      bad: { color: '#d0453c', fontSize: 12, whiteSpace: 'pre-wrap' },
    };

    /** One pool: its slot list with add/remove, and its model sub-pools read-only. */
    function PoolEditor(props) {
      const { refName, spec, onChange, onRemove } = props;
      const [text, setText] = React.useState('');
      const slots = spec.keys ?? [];
      const add = () => {
        const value = text.trim();
        if (value === '') return;
        onChange({ ...spec, keys: [...slots, value] });
        setText('');
      };
      return h('div', { style: styles.pool },
        h('div', { style: styles.row },
          h('strong', null, refName),
          h('span', { style: styles.muted }, `${slots.length} slot${slots.length === 1 ? '' : 's'}`),
          h('button', { style: styles.button, onClick: onRemove }, 'Remove pool'),
        ),
        slots.map((slot, index) =>
          h('div', { key: `${slot}:${index}`, style: styles.slot },
            h('code', null, slot),
            h('button', {
              style: styles.button,
              'aria-label': `remove slot ${slot} from ${refName}`,
              onClick: () => onChange({ ...spec, keys: slots.filter((_, at) => at !== index) }),
            }, 'Remove'),
          ),
        ),
        h('div', { style: styles.row },
          h('input', {
            style: styles.grow,
            value: text,
            placeholder: 'credential reference, e.g. ACME_KEY_3',
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') add(); },
          }),
          h('button', { style: styles.button, onClick: add }, 'Add slot'),
        ),
        Object.keys(spec.models ?? {}).length > 0
          ? h('div', { style: styles.muted }, `model pools (hand-edited): ${Object.keys(spec.models).join(', ')}`)
          : null,
      );
    }

    /** The card body: one editor per pool, an add-pool row, and the save line. */
    function PoolCard(props) {
      const ctx = props.ctx;
      const scope = React.useMemo(() => ctx.settingsScope.bind({ namespace: NS }), [ctx]);
      const subscribe = React.useCallback((listener) => scope.subscribe(listener), [scope]);
      const snapshot = React.useSyncExternalStore(subscribe, () => scope.getSnapshot());
      const [draftPools, setDraftPools] = React.useState(undefined);
      const [newRef, setNewRef] = React.useState('');
      const [status, setStatus] = React.useState(undefined);

      const pools = draftPools ?? snapshot.value?.pools ?? {};
      const dirty = draftPools !== undefined;

      const addPool = () => {
        const ref = newRef.trim();
        if (ref === '') return;
        if (Object.hasOwn(pools, ref)) {
          setStatus({ kind: 'bad', message: `pool ${ref} already exists` });
          return;
        }
        setStatus(undefined);
        setDraftPools({ ...pools, [ref]: { keys: [] } });
        setNewRef('');
      };

      const save = async () => {
        setStatus(undefined);
        try {
          await scope.set('pools', draftPools);
          setDraftPools(undefined);
          setStatus({ kind: 'ok', message: 'Saved.' });
        } catch (error) {
          setStatus({ kind: 'bad', message: error?.message ?? String(error) });
        }
      };

      return h('div', { style: styles.card },
        Object.keys(pools).length === 0
          ? h('div', { style: styles.muted }, 'No pool configured yet — a pool is one credential reference served by several stored keys.')
          : null,
        Object.entries(pools).map(([refName, spec]) =>
          h(PoolEditor, {
            key: refName,
            refName,
            spec,
            onChange: (next) => setDraftPools({ ...pools, [refName]: next }),
            onRemove: () => {
              const next = { ...pools };
              delete next[refName];
              setDraftPools(next);
            },
          }),
        ),
        h('div', { style: styles.row },
          h('input', {
            style: styles.grow,
            value: newRef,
            placeholder: 'new pool: the reference a route resolves, e.g. ACME_KEY',
            onChange: (event) => setNewRef(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') addPool(); },
          }),
          h('button', { style: styles.button, onClick: addPool }, 'Add pool'),
        ),
        h('div', { style: styles.row },
          h('button', { style: styles.button, onClick: save, disabled: !dirty }, 'Save'),
          dirty
            ? h('button', { style: styles.button, onClick: () => { setDraftPools(undefined); setStatus(undefined); } }, 'Discard')
            : null,
          status === undefined
            ? null
            : h('span', { style: status.kind === 'ok' ? styles.ok : styles.bad, role: 'status' }, status.message),
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('settings.plugin.item', () =>
            ctx.slots.register(
              { name: 'settings.plugin.item', key: NS, locale: NS, inject: () => ({ ctx }) },
              PoolCard,
            ),
          ),
        'dsh-multi-api-plugin: settings card',
      );
    }

    exports.apply = apply;
    exports.inject = ['slots', 'settingsScope'];
    return module.exports;
  },
});
