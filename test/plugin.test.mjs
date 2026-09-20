// Integration tests: the real plugin mounted in a real cordis context, against
// the real @deepseek-ai/dsh-llm runtime, with memory-backed credential and
// settings services and a gateway adapter that mimics how
// @deepseek-ai/dsh-llm-pi-ai resolves `apiKeyEnv` per request.

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
// The suite runs against the source by default; PLUGIN_SPEC points it at an
// installed copy of the packed artifact to verify what actually ships.
const plugin = await import(process.env.PLUGIN_SPEC ?? '../lib/index.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The credentials service, backed by a plain object instead of `.credentials.yaml`. */
class MemoryCredentials extends CredentialProvider {
  constructor(ctx, values) {
    super(ctx, 'credentials')
    this.values = values
  }
  async resolve(ref) {
    const value = this.values[ref]
    if (value === undefined || value === '') return undefined
    return { value, source: 'store' }
  }
  async describe(ref) {
    return { configured: this.values[ref] !== undefined, source: 'store', writable: true }
  }
  async set(ref, value) {
    this.values[ref] = value
  }
  async unset(ref) {
    delete this.values[ref]
  }
  async readRecord() {
    return undefined
  }
  async describeRecord() {
    return { configured: false, writable: true }
  }
  async listRecords() {
    return []
  }
  async modifyRecord() {
    return undefined
  }
  async deleteRecord() {}
}

/** The settings provider, backed by an in-memory document instead of `settings.yaml`. */
class MemorySettings extends SettingsProvider {
  constructor(ctx, document) {
    super(ctx, 'settings')
    this.document = document
  }
  get writable() {
    return true
  }
  async load() {
    return this.document
  }
  async persist(ns, section) {
    this.document[ns] = section
  }
  /** Publish the document without the provider's own init step. */
  publishNow() {
    this.publish(this.document)
  }
}

/**
 * A hand-declared gateway route: the profile names a credential reference, and
 * the adapter resolves it through the seam on every request — which is the only
 * thing the rotation plugin needs from a provider.
 */
class GatewayAdapter extends LlmAdapter {
  constructor(credentials, profiles, seen) {
    super()
    this.credentials = credentials
    this.profiles = profiles
    this.seen = seen
  }
  providerInfo(provider) {
    return { id: provider, name: provider }
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }
  async *stream(options) {
    const ref = this.profiles[options.provider].apiKeyEnv
    const hit = await this.credentials.resolve(credentialRef(ref))
    const key = hit?.value
    this.seen.push({ provider: options.provider, ref, key, at: Date.now() })
    if (key === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: Object.freeze({ code: 'MISSING_CREDENTIAL', message: `no credential for ${ref}` }) } }
      return
    }
    if (key.startsWith('rate-limited')) {
      await sleep(5)
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: Object.freeze({ code: 'RATE_LIMIT', message: `429 for ${key}`, providerRetryAfterMs: 30_000 }) },
      }
      return
    }
    if (key.startsWith('auth')) {
      yield { type: 'finish', reason: { kind: 'error', failure: Object.freeze({ code: 'AUTH', message: `401 for ${key}` }) } }
      return
    }
    if (key.startsWith('server')) {
      yield { type: 'finish', reason: { kind: 'error', failure: Object.freeze({ code: 'SERVER', message: `503 for ${key}` }) } }
      return
    }
    if (key.startsWith('flaky')) {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      yield { type: 'finish', reason: { kind: 'error', failure: Object.freeze({ code: 'RATE_LIMIT', message: 'late 429' }) } }
      return
    }
    yield { type: 'text-delta', index: 0, text: `served-by:${key}` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const PROFILES = {
  'acme-gateway': { apiKeyEnv: 'ACME_KEY' },
  openai: { apiKeyEnv: 'OPENAI_KEY' },
}

/**
 * Mount the runtime, the services, and the plugin under test.
 *
 * The `llm-pi-ai` namespace is registered here with the same shape the shipped
 * adapter uses, so route discovery runs the production path: directory entry →
 * settings namespace → profile path → `apiKeyEnv`.
 */
async function harness({ values, config = {}, document = {}, profiles = PROFILES, declared = true } = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)

  const credentials = new MemoryCredentials(ctx, values)
  const settings = new MemorySettings(ctx, { 'llm-pi-ai': { providers: profiles }, ...document })
  settings.register(
    'llm-pi-ai',
    Schema.object({ providers: Schema.dict(Schema.object({ apiKeyEnv: Schema.string() })).default({}) }),
  )
  settings.publishNow()

  const seen = []
  // The adapter mounts in its own context, like the shipped adapters do, so it
  // reaches the credential service through a *different* context's service
  // mirror than the one the plugin patches.
  ctx.plugin({
    name: 'gateway-adapter',
    inject: ['llm', 'credentials'],
    apply(c) {
      if (declared) {
        c.llm.registerConfigurableProviders(
          Object.keys(profiles).map((provider) => ({
            provider,
            displayName: provider,
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', provider],
            declared: true,
          })),
        )
      }
      c.llm.registerAdapter(Object.keys(profiles), new GatewayAdapter(c.credentials, profiles, seen))
    },
  })

  const fork = ctx.plugin(plugin, config)
  await tick()
  return { ctx, fork, credentials, settings, seen }
}

const collect = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const textOf = (chunks) => chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
const failureOf = (chunks) => chunks.at(-1)?.reason?.failure
const call = (ctx, provider = 'acme-gateway') =>
  ctx.llm.stream({ provider, model: 'acme-think', messages: [] })

const POOL = { pools: { ACME_KEY: { keys: ['ACME_KEY_1', 'ACME_KEY_2'] } } }

test('rotates to the next pooled key inside one llm.stream call', async () => {
  const { ctx, seen } = await harness({
    values: { ACME_KEY_1: 'rate-limited-1', ACME_KEY_2: 'good-2' },
    config: POOL,
  })
  const chunks = await collect(call(ctx))
  assert.equal(textOf(chunks), 'served-by:good-2')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(
    seen.map((entry) => entry.key),
    ['rate-limited-1', 'good-2'],
  )
})

test('a custom route that only names the pooled reference rotates — nothing lists it by name', async () => {
  const { ctx, seen } = await harness({
    values: { ACME_KEY_1: 'rate-limited-1', ACME_KEY_2: 'good-2', OPENAI_KEY: 'openai-key' },
    config: POOL,
  })
  const custom = await collect(call(ctx, 'acme-gateway'))
  assert.equal(textOf(custom), 'served-by:good-2')
  const other = await collect(call(ctx, 'openai'))
  assert.equal(textOf(other), 'served-by:openai-key')
  assert.equal(seen.filter((entry) => entry.provider === 'openai').length, 1, 'an unpooled route is untouched')
})

test('AUTH is a switch code out of the box', async () => {
  const { ctx } = await harness({
    values: { ACME_KEY_1: 'auth-1', ACME_KEY_2: 'good-2' },
    config: POOL,
  })
  const chunks = await collect(call(ctx))
  assert.equal(textOf(chunks), 'served-by:good-2')
})

test('a pool can narrow the switch codes it reacts to', async () => {
  const { ctx, seen } = await harness({
    values: { ACME_KEY_1: 'rate-limited-1', ACME_KEY_2: 'good-2' },
    config: { pools: { ACME_KEY: { keys: ['ACME_KEY_1', 'ACME_KEY_2'], switchCodes: ['AUTH'] } } },
  })
  const chunks = await collect(call(ctx))
  assert.equal(failureOf(chunks).code, 'RATE_LIMIT', 'a pool that only rotates on AUTH keeps the rate-limit failure')
  assert.equal(seen.length, 1)
})

test('maxAttemptsPerRequest bounds the failover', async () => {
  const { ctx, seen } = await harness({
    values: { ACME_KEY_1: 'rate-limited-1', ACME_KEY_2: 'good-2' },
    config: { ...POOL, maxAttemptsPerRequest: 1 },
  })
  const chunks = await collect(call(ctx))
  assert.equal(failureOf(chunks).code, 'RATE_LIMIT')
  assert.equal(seen.length, 1, 'the caller asked for at most one attempt')
})

test('a route whose adapter declares no directory entry needs the explicit connection', async () => {
  const values = { ACME_KEY_1: 'rate-limited-1', ACME_KEY_2: 'good-2' }

  const undeclared = await harness({ values, declared: false, config: POOL })
  const plain = await collect(call(undeclared.ctx))
  assert.equal(failureOf(plain).code, 'MISSING_CREDENTIAL', 'no route mapping means no pool for this dispatch')
  assert.deepEqual(undeclared.seen.map((entry) => entry.key), [undefined])

  const mapped = await harness({
    values,
    declared: false,
    config: { ...POOL, routes: { 'acme-gateway': { ref: 'ACME_KEY' } } },
  })
  const chunks = await collect(call(mapped.ctx))
  assert.equal(textOf(chunks), 'served-by:good-2')
  assert.deepEqual(
    mapped.seen.map((entry) => entry.key),
    ['rate-limited-1', 'good-2'],
  )
})

test('honours the provider retry-after hint as the cooldown', async () => {
  const { ctx, seen } = await harness({
    values: { ACME_KEY_1: 'rate-limited-1', ACME_KEY_2: 'good-2' },
    config: POOL,
  })
  await collect(call(ctx))
  seen.length = 0
  await collect(call(ctx))
  assert.deepEqual(
    seen.map((entry) => entry.key),
    ['good-2'],
    'the parked key stays out of rotation on the next request',
  )
})

test('a retryable-but-unattributable failure is passed through untouched', async () => {
  const { ctx, seen } = await harness({
    values: { ACME_KEY_1: 'server-1', ACME_KEY_2: 'good-2' },
    config: POOL,
  })
  const chunks = await collect(call(ctx))
  assert.equal(failureOf(chunks).code, 'SERVER')
  assert.equal(seen.length, 1, 'a provider-side outage is not blamed on the key')
})

test('never retries after content reached the caller', async () => {
  const { ctx, seen } = await harness({
    values: { ACME_KEY_1: 'flaky-1', ACME_KEY_2: 'good-2' },
    config: POOL,
  })
  const chunks = await collect(call(ctx))
  assert.equal(textOf(chunks), 'partial')
  assert.equal(failureOf(chunks).code, 'RATE_LIMIT')
  assert.equal(seen.length, 1)
})

test('attribution stays per-request under concurrent traffic', async () => {
  const { ctx, seen } = await harness({
    values: {
      ACME_KEY_1: 'rate-limited-1',
      ACME_KEY_2: 'rate-limited-2',
      ACME_KEY_3: 'good-3',
      ACME_KEY_4: 'good-4',
    },
    config: { pools: { ACME_KEY: { keys: ['ACME_KEY_1', 'ACME_KEY_2', 'ACME_KEY_3', 'ACME_KEY_4'] } } },
  })
  const [first, second] = await Promise.all([collect(call(ctx)), collect(call(ctx))])
  assert.match(textOf(first), /^served-by:good-/)
  assert.match(textOf(second), /^served-by:good-/)
  assert.notEqual(textOf(first), textOf(second), 'the two calls drained different keys')
  assert.deepEqual(
    [...new Set(seen.map((entry) => entry.key))].sort(),
    ['good-3', 'good-4', 'rate-limited-1', 'rate-limited-2'],
    'each call drained its own slots and no slot was served to both',
  )
})

test('an exhausted pool keeps answering, and stops retrying once nothing can help', async () => {
  const { ctx, seen } = await harness({
    values: { ACME_KEY_1: 'rate-limited-1', ACME_KEY_2: 'rate-limited-2' },
    config: POOL,
  })
  const chunks = await collect(call(ctx))
  assert.equal(failureOf(chunks).code, 'RATE_LIMIT', 'the provider failure reaches the caller unchanged')
  assert.equal(seen.length, 2, 'one attempt per slot, then stop')
  seen.length = 0
  const later = await collect(call(ctx))
  assert.equal(failureOf(later).code, 'RATE_LIMIT')
  assert.equal(seen.length, 1, 'with every slot cooling the pool still answers, once')
})

test('a pooled slot with no stored value is skipped', async () => {
  const { ctx, seen } = await harness({
    values: { ACME_KEY_2: 'good-2' },
    config: POOL,
  })
  const chunks = await collect(call(ctx))
  assert.equal(textOf(chunks), 'served-by:good-2')
  assert.equal(seen.length, 1)
})

test('a pool whose slots are all unset keeps the adapter’s own diagnosis', async () => {
  const { ctx } = await harness({ values: {}, config: POOL })
  const chunks = await collect(call(ctx))
  assert.equal(failureOf(chunks).code, 'MISSING_CREDENTIAL')
  assert.match(failureOf(chunks).message, /ACME_KEY/)
})

test('a resolution outside a model dispatch stays ambient', async () => {
  const { credentials, seen } = await harness({
    values: { ACME_KEY: 'ambient-key', ACME_KEY_1: 'rate-limited-1', ACME_KEY_2: 'good-2' },
    config: POOL,
  })
  const hit = await credentials.resolve(credentialRef('ACME_KEY'))
  assert.equal(hit.value, 'ambient-key', 'a presence check or a discovery request sees the ambient credential')
  assert.equal(seen.length, 0)
})

test('a loop-built request is only read, never rewritten', async () => {
  const { ctx } = await harness({
    values: { ACME_KEY_1: 'rate-limited-1', ACME_KEY_2: 'good-2' },
    config: POOL,
  })
  const frozen = Object.freeze({
    provider: 'acme-gateway',
    model: 'acme-think',
    messages: Object.freeze([Object.freeze({ role: 'user', content: 'hi' })]),
  })
  const chunks = await collect(ctx.llm.stream(frozen))
  assert.equal(textOf(chunks), 'served-by:good-2')
})

test('pools and routing tables follow the settings document without a restart', async () => {
  const { ctx, settings, seen } = await harness({
    values: { ACME_KEY: 'rate-limited-ambient', ACME_KEY_1: 'rate-limited-1', ACME_KEY_2: 'good-2' },
    config: {},
  })
  const before = await collect(call(ctx))
  assert.equal(failureOf(before).code, 'RATE_LIMIT', 'no pool configured yet: the ambient key answers alone')
  assert.deepEqual(seen.map((entry) => entry.key), ['rate-limited-ambient'])

  settings.document['dsh-multi-api-plugin'] = { pools: { ACME_KEY: { keys: ['ACME_KEY_1', 'ACME_KEY_2'] } } }
  settings.publishNow()

  const after = await collect(call(ctx))
  assert.equal(textOf(after), 'served-by:good-2', 'the edited section takes effect on the next request')
})

test('disposing the plugin restores the credential resolution exactly', async () => {
  const { ctx, fork, credentials } = await harness({
    values: { ACME_KEY: 'ambient-key', ACME_KEY_1: 'rate-limited-1', ACME_KEY_2: 'good-2' },
    config: POOL,
  })
  assert.notEqual(Object.getOwnPropertyDescriptor(credentials, 'resolve'), undefined, 'the patch is installed')

  await fork.dispose()

  assert.equal(Object.getOwnPropertyDescriptor(credentials, 'resolve'), undefined, 'the patch left no own property')
  const hit = await credentials.resolve(credentialRef('ACME_KEY'))
  assert.equal(hit.value, 'ambient-key')
  await ctx.fiber.dispose()
})

test('a settings write that is not a credential reference is refused where it is written', async () => {
  const { ctx, settings } = await harness({ values: {}, config: POOL })
  const scope = settings.register('dsh-multi-api-plugin-write', plugin.Config, { base: {} })
  await assert.rejects(
    () => scope.update({ pools: { ACME_KEY: { keys: ['not a reference'] } } }),
    /credential reference/,
    'a typo cannot silently become an inert pool',
  )
  await assert.doesNotReject(() => scope.update({ pools: { ACME_KEY: { keys: ['ACME_KEY_1'] } } }))
  await ctx.fiber.dispose()
})
