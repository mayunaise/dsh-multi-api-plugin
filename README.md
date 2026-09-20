# dsh-multi-api-plugin

Per-provider API-key rotation for DeepSeek Harness: give each credential
reference a pool of keys, and a request that fails because the key behind it is
rate-limited, out of quota, or rejected finishes on the next key of the pool —
inside the same call, with no change to the request the caller built.

```
request ──► llm/stream ──► provider adapter ──► 429 / quota / 401
                │                    ▲
                │  next slot         │ resolve(ref): pooled key
                └────────────────────┘        (pool ACME_GATEWAY_KEY)
```

A pool is addressed by the **credential reference** a route already resolves, and
each route's reference is discovered from the harness's own provider directory —
so a route that appears later (a hand-declared gateway, a third-party adapter)
rotates without any change here.

## Install

```bash
dsh plugin --profile web add dsh-multi-api-plugin
# or from a checkout:
dsh plugin --profile web add /path/to/dsh-multi-api-plugin
```

Store the keys of a pool under their own references:

```bash
dsh credentials set ACME_GATEWAY_KEY_1 sk-...
dsh credentials set ACME_GATEWAY_KEY_2 sk-...
```

## Configure

The plugin owns the settings namespace `dsh-multi-api-plugin` (edit it in
`settings.yaml`, in the settings UI, or as the plugin's config in
`cordis.patch.yml`):

```yaml
dsh-multi-api-plugin:
  cooldownMs: 60000            # default cooldown for a slot that failed
  maxCooldownMs: 900000        # upper bound, whatever the provider hints
  maxAttemptsPerRequest: 0     # 0 = the pool's size
  switchCodes: [RATE_LIMIT, QUOTA, AUTH]
  pools:
    ACME_GATEWAY_KEY:          # the credential reference the route resolves
      keys: [ACME_GATEWAY_KEY_1, ACME_GATEWAY_KEY_2, ACME_GATEWAY_KEY_3]
      models:                  # optional: model-scoped slot lists
        acme-think-large:      # matches the model id the request names
          keys: [ACME_GATEWAY_KEY_4, ACME_GATEWAY_KEY_5]
    OPENAI_KEY:
      keys: [OPENAI_KEY_1, OPENAI_KEY_2]
      cooldownMs: 120000       # per-pool override
      switchCodes: [RATE_LIMIT, QUOTA]   # e.g. never rotate on AUTH here
  routes:                      # optional, see "Routing" below
    hand-rolled-gateway:
      ref: HAND_ROLLED_KEY
```

Every key is a reference **name**: the values live in the credential store or the
environment, and nothing else (no secret) is ever read or written by this plugin.
A value that is not a reference name is refused where it is written.

A `models` entry gives one model id its own candidate list: a request naming that
model draws only from the sub-pool's slots, while every other model draws from the
pool's own `keys`. Cooldowns stay pool-level — they are keyed by *slot*, so a key
that drew a 429 is parked for the whole pool, whichever model asked. A model entry
without slot names is ignored with a warning, and that model draws from the pool.

The document is hot-reloaded: editing a pool takes effect on the next request,
and a pool whose definition did not change keeps its cooldowns.

### Settings card

The plugin ships a browser half that renders its own card under
Settings → Plugins → Plugin settings. The card edits the pool-level slot lists —
add or remove a pool, add or remove a slot — and saves through the settings
scope, so the same reference-name validation applies: a value that is not a
credential reference is refused by the host and the refusal is shown on the card.
Model-scoped sub-pools are displayed read-only and stay hand-edited for now.

## Routing

`pools` is keyed by the reference; which routes use it is discovered per request
from `ctx.llm.listConfigurableProviders()` — each entry names the settings
namespace and the path of the profile whose `apiKeyEnv` is the reference. That
covers the shipped catalog (`llm-deepseek`) and every `llm-pi-ai` provider,
including a custom one:

```yaml
llm-pi-ai:
  providers:
    acme-gateway:
      baseURL: https://gateway.acme.example/v1
      apiKeyEnv: ACME_GATEWAY_KEY
```

Add `routes.<provider>.ref` only when an adapter resolves a pooled reference but
declares no directory entry of its own; without a mapping the plugin has no pool
to attribute that route's dispatch to. (This also makes a setup easy to verify —
if a route is not rotating, check that it is either declared or mapped.)

## How it works

Two existing seams, and no provider identity change:

1. **`ctx.credentials.resolve`** — at a model dispatch the plugin answers the
   route's reference from the pool instead of the ambient credential. The choice
   is scoped to that dispatch (`AsyncLocalStorage`): a settings or doctor probe
   asking whether a key is set, or an endpoint `discoverModels` request, keeps
   reading the ambient value and never advances the rotation. The served slot is
   carried in the same record, so under concurrent traffic each failure is
   attributed to the key that caused it, not to a shared "last used" pointer.
2. **the `llm/stream` waterfall** — a failure that arrives **before any content**
   and whose code is in `switchCodes` parks the slot for
   `providerRetryAfterMs ?? cooldownMs` (capped) and re-enters the same
   continuation with the next slot.

Deliberate behaviours:

- **Failures stay the provider's.** Only the switch codes above move a request;
  a `SERVER`/`TIMEOUT`/`TRANSPORT` failure is passed through untouched, and
  `@deepseek-ai/dsh-llm-retry` keeps owning step-level backoff — this plugin
  registers no retry policy of its own.
- **No duplicate output.** Once a token delta has reached the caller, a late
  failure ends the request; a retry would replay a prefix the user already saw.
- **A pool always answers.** When every slot is cooling, the request still goes
  to the slot that recovers soonest instead of failing with a rotation error,
  and a slot that resolves to nothing is parked and skipped. If no slot is
  configured at all, the answer stays empty so the adapter raises its own
  `MISSING_CREDENTIAL` naming the reference to fix.
- **The request is read-only.** A loop-built request arrives deep-frozen; the
  adapter is re-entered through the same continuation, and nothing in it is
  rebuilt or rewritten.

## Non-goals

- Editing model-scoped sub-pools in the settings card (the card edits the
  pool-level slot lists; sub-pools are hand-edited) and per-slot metadata.
- No cost budgets, no cross-provider cascade, no circuit breaker, no cooldown
  persistence: cooldowns live in the process run, which is the unit a rate limit
  applies to.
- No new provider route: the plugin never changes which provider a request names,
  so replay state, model pickers, and the session log stay intact.

## Operating notes

- **Do not mount together with `@goodandready/dsh-key-rotation`** — both patch
  the credential seam, and the second patch would wrap the first.
- The plugin is active only for routes with a configured pool; with no `pools`,
  it installs its two hooks and does nothing.
- Logs are one deduplicated line per event (`switch`, `pool-exhausted`,
  `missing-slot`, …). A line names the reference and a 5-character tail — never a
  key value.

## Development

```bash
npm install          # peer dependencies, for the test suite
npm test             # node --test test/*.test.mjs
```

The suite mounts the real plugin in a real cordis context against the real
`@deepseek-ai/dsh-llm` runtime, with memory-backed credential and settings
services and a gateway adapter that resolves `apiKeyEnv` through the seam exactly
like the shipped adapters do.

## License

MIT
