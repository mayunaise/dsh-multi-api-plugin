/**
 * In-request failover over the `llm/stream` waterfall.
 *
 * The waterfall wraps every streaming model call — a plain `ctx.llm.stream()` and
 * the agent loop's prepared dispatch both reach it — so one listener can retry
 * the call on the next pool slot without touching the request the caller built.
 *
 * Three rules keep the retry honest:
 *
 * - **Only before content.** A retry after a token delta reached the caller would
 *   duplicate an already-shown prefix, so a failure past that point is passed
 *   through unchanged.
 * - **Only when another slot can help.** A switchable failure moves to the next
 *   slot only if one is not cooling; otherwise the provider's own failure — with
 *   its code and facts intact — is what the caller sees.
 * - **Never mutate the request.** A loop-built request arrives deep-frozen, and
 *   the adapter is re-entered through the same `next()` continuation, so the
 *   caller's `options` object is only ever read.
 *
 * The served slot is attributed to the request that used it through
 * `AsyncLocalStorage`: the adapter resolves its credential inside the stream
 * body, and the store is only visible to that body if the driver resumes the
 * stream from inside `als.run(...)` — which is exactly how the loop below pulls
 * every chunk.
 *
 * @module dsh-multi-api-plugin/stream
 */

import { isTokenDelta } from '@deepseek-ai/dsh-llm'

/**
 * Build the `llm/stream` listener.
 *
 * @param {object} spec - dependencies.
 * @param {import('node:async_hooks').AsyncLocalStorage<{ provider?: string, slot?: string }>} spec.als
 *   the per-dispatch pin shared with the credential patch.
 * @param {() => { pools: Map<string, any>, routeToRef: Map<string, string>, maxAttemptsPerRequest: number }} spec.build
 *   the current rotation runtime.
 * @param {(kind: string, fields?: object) => boolean} spec.report - event sink.
 * @returns {(options: object, next: () => AsyncIterable<any>) => AsyncIterable<any>} the listener.
 */
export function createInterceptor({ als, build, report }) {
  return function intercept(options, next) {
    const runtime = build()
    const ref = runtime.routeToRef.get(options.provider)
    const pool = ref === undefined ? undefined : runtime.pools.get(ref)
    if (pool === undefined) return next()
    return rotate(options, next, runtime, pool)
  }

  /**
   * Drive the provider stream, failing over to the next slot on an attributable
   * failure that arrived before any content.
   *
   * @param {object} options - the request, read-only.
   * @param {() => AsyncIterable<any>} next - the rest of the waterfall.
   * @param {object} runtime - the rotation runtime.
   * @param {object} pool - the pool answering this route's reference.
   * @returns {AsyncGenerator<any>} the chunk stream the caller observes.
   */
  async function* rotate(options, next, runtime, pool) {
    const limit =
      runtime.maxAttemptsPerRequest > 0
        ? Math.min(runtime.maxAttemptsPerRequest, pool.keys.length)
        : pool.keys.length

    for (let attempt = 1; attempt <= limit; attempt++) {
      const context = { provider: options.provider, slot: undefined }
      const iterator = next()[Symbol.asyncIterator]()
      let emitted = false
      let switching = false

      try {
        for (;;) {
          const step = await als.run(context, () => iterator.next())
          if (step.done) return
          const chunk = step.value
          if (isTokenDelta(chunk)) emitted = true

          if (chunk?.type === 'finish') {
            const failure = chunk.reason?.failure
            if (chunk.reason?.kind === 'error' && !emitted && pool.switches.has(failure?.code)) {
              const cooldownMs = pool.cool(context.slot, failure?.providerRetryAfterMs ?? pool.cooldownMs)
              report('switch', {
                provider: options.provider,
                ref: pool.ref,
                slot: context.slot,
                code: failure?.code,
                cooldownMs,
                attempt,
              })
              // Retry only while another slot can plausibly answer: re-sending to
              // a slot this request just parked would bill a request and fail alike.
              switching = attempt < limit && !pool.everyCooling()
            }
            if (!switching) yield chunk
            break
          }

          yield chunk
        }
      } finally {
        await closeIterator(iterator)
      }

      if (!switching) return
    }
  }
}

/**
 * Release a provider stream the consumer stopped reading, then let its pending
 * work settle so a cancellation cannot leave a stream running behind us.
 *
 * @param {AsyncIterator<any>} iterator - the stream being abandoned.
 */
async function closeIterator(iterator) {
  const returned = iterator.return?.()
  if (returned !== undefined) await returned
}
