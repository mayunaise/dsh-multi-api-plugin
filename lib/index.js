/**
 * dsh-multi-api-plugin — per-provider API-key rotation for DeepSeek Harness.
 *
 * Give each credential reference a pool of keys; a request that fails because the
 * key is rate-limited, out of quota, or rejected completes on the next key of the
 * pool without the caller noticing, and without the provider identity ever
 * changing (so replay state, model pickers, and the session log stay intact).
 *
 * The plugin hooks two existing seams and registers one settings namespace:
 *
 * - `ctx.credentials.resolve` chooses the slot for a dispatch-time resolution,
 * - the `llm/stream` waterfall fails the request over to the next slot,
 * - the `dsh-multi-api-plugin` settings section declares the pools.
 *
 * Routing tables: a pool is addressed by the credential reference a route
 * resolves, and each route's reference is discovered from the harness's
 * configurable-provider directory — so a route added later, including a
 * hand-declared gateway, rotates without any change here.
 *
 * @module dsh-multi-api-plugin
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import Schema from '@deepseek-ai/schemastery'
import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { DEFAULT_SWITCH_CODES, createPool } from './pool.js'
import { discoverRoutes } from './discovery.js'
import { installResolvePatch } from './resolve.js'
import { createInterceptor } from './stream.js'
import { createReporter } from './events.js'

export const name = 'dsh-multi-api-plugin'

/** The settings namespace this plugin registers, and the key its section lives under. */
export const NS = name

export const inject = ['llm', 'credentials', 'settings']

/** One credential reference: a POSIX shell identifier naming a stored key or an environment variable. */
const refName = Schema.transform(Schema.string(), (value) => {
  if (!isCredentialRefName(value)) {
    throw new Error(
      `"${value}" is not a credential reference — use a POSIX shell identifier such as ACME_GATEWAY_KEY`,
    )
  }
  return value
})

export const Config = Schema.object({
  cooldownMs: Schema.natural().default(60_000),
  maxCooldownMs: Schema.natural().default(900_000),
  maxAttemptsPerRequest: Schema.natural().default(0),
  switchCodes: Schema.array(Schema.string()).default([...DEFAULT_SWITCH_CODES]),
  pools: Schema.dict(
    Schema.object({
      keys: Schema.array(refName).default([]),
      // Model-scoped sub-pools: a model named here draws its slots from its own
      // list instead of the pool's. Cooldowns stay pool-level — they are keyed by
      // slot, so one failed key is parked for every model of the pool.
      models: Schema.dict(Schema.object({ keys: Schema.array(refName).default([]) })).default({}),
      cooldownMs: Schema.natural(),
      maxCooldownMs: Schema.natural(),
      switchCodes: Schema.array(Schema.string()),
    }),
  ).default({}),
  routes: Schema.dict(Schema.object({ ref: refName })).default({}),
})

/**
 * Mount the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} config - the composition layer of this plugin's settings section.
 */
export function apply(ctx, config = {}) {
  if (typeof ctx.llm.listConfigurableProviders !== 'function') {
    throw new Error(
      'dsh-multi-api-plugin: this runtime has no ctx.llm.listConfigurableProviders(), so the plugin cannot learn ' +
        'which credential reference each provider route resolves; mount a compatible @deepseek-ai/dsh-llm',
    )
  }

  const als = new AsyncLocalStorage()
  const report = createReporter({ logger: ctx.logger })
  const scope = ctx.settings.register(NS, Config, { base: config })
  const poolCache = new Map()
  let memo = { signature: undefined, runtime: undefined }

  /**
   * Resolve the current rotation runtime.
   *
   * The settings document is hot-reloaded, so the pools and the routing table are
   * derived per call and memoized on a signature of everything they depend on. A
   * pool whose definition did not change survives a settings edit with its
   * cooldowns intact — an unrelated edit must not hand a rate-limited key back
   * its turn.
   *
   * @returns {{ pools: Map<string, any>, routeToRef: Map<string, string>, maxAttemptsPerRequest: number }} the runtime.
   */
  function build() {
    const value = scope.get()
    const routeToRef = discoverRoutes({ llm: ctx.llm, settings: ctx.settings, routes: value.routes })
    const signature = JSON.stringify([value, [...routeToRef]])
    if (memo.signature === signature) return memo.runtime

    const pools = new Map()
    for (const [ref, spec] of Object.entries(value.pools)) {
      if (!isCredentialRefName(ref)) {
        report('invalid-ref', { ref, message: `pool "${ref}" is not a credential reference and is ignored` })
        continue
      }
      const keys = [...new Set(spec.keys)]
      if (keys.length === 0) {
        report('pool-empty', { ref })
        continue
      }
      // A model entry without slot names would silently narrow that model's
      // rotation to nothing; say so and let it draw from the pool's own slots.
      const models = []
      for (const [model, sub] of Object.entries(spec.models)) {
        const subKeys = [...new Set(sub.keys)]
        if (subKeys.length === 0) {
          report('model-pool-empty', { ref, model })
          continue
        }
        models.push([model, subKeys])
      }
      const cooldownMs = spec.cooldownMs ?? value.cooldownMs
      const maxCooldownMs = spec.maxCooldownMs ?? value.maxCooldownMs
      // The schema resolves an absent nested `switchCodes` to `[]`, so the empty
      // list has to mean "inherit": a pool that switches on nothing never rotates,
      // which is never what the section says.
      const switchCodes = spec.switchCodes?.length ? spec.switchCodes : value.switchCodes
      const poolSignature = JSON.stringify([keys, models, cooldownMs, maxCooldownMs, switchCodes])
      const cached = poolCache.get(ref)
      if (cached !== undefined && cached.signature === poolSignature) {
        pools.set(ref, cached.pool)
        continue
      }
      const pool = createPool({ ref, keys, models, cooldownMs, maxCooldownMs, switchCodes })
      poolCache.set(ref, { signature: poolSignature, pool })
      pools.set(ref, pool)
    }
    for (const ref of poolCache.keys()) {
      if (!pools.has(ref)) poolCache.delete(ref)
    }

    memo = {
      signature,
      runtime: { pools, routeToRef, maxAttemptsPerRequest: value.maxAttemptsPerRequest },
    }
    return memo.runtime
  }

  ctx.effect(
    () => installResolvePatch({ credentials: ctx.credentials, als, build, report }),
    'dsh-multi-api-plugin: credentials.resolve',
  )
  ctx.effect(
    () => ctx.on('llm/stream', createInterceptor({ als, build, report })),
    'dsh-multi-api-plugin: llm/stream',
  )
}
