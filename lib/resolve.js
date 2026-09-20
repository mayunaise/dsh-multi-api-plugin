/**
 * Dispatch-time slot selection over the credential seam.
 *
 * The seam resolves a reference per operation and publishes no interception
 * point, and cordis refuses to replace an already provided service, so replacing
 * the method on the service is the only way to answer a model call with a pooled
 * key. This module owns that patch and its restoration.
 *
 * How the write lands: a plugin never sees the raw service instance — `ctx.credentials`
 * is a per-context tracking mirror. Assigning through it writes to the underlying
 * instance, and every other context's mirror reads that instance on each access
 * (each read is re-wrapped for tracking, so identity comparison across reads is
 * meaningless — hence no self-check here), which is why one patch covers the
 * provider adapter that actually resolves the key. Disposal deletes the property
 * again, restoring the prototype lookup for every context.
 *
 * Two rules keep the patch honest:
 *
 * - **Dispatch-scoped.** Only a resolution that belongs to a model call rotates.
 *   A configuration surface probing whether a key is set, or an endpoint model
 *   discovery request, keeps reading the ambient credential and never advances
 *   the rotation.
 * - **Provider-owned failures.** A slot that resolves to nothing is parked and
 *   the next slot is tried; when no slot is configured the answer stays
 *   `undefined`, so the adapter raises its own `MISSING_CREDENTIAL` naming the
 *   reference to fix rather than a rotation error nobody can act on.
 *
 * @module dsh-multi-api-plugin/resolve
 */

/**
 * Pick from a pool and resolve the chosen slot.
 *
 * @param {object} spec - dependencies.
 * @param {object} spec.pool - the pool answering for this reference.
 * @param {string} spec.ref - the reference the caller asked for.
 * @param {(ref: string) => Promise<{ value: string, source: string } | undefined>} spec.resolveRef
 *   the unpatched resolution, which layers the environment over the store.
 * @param {(kind: string, fields?: object) => boolean} spec.report - event sink.
 * @param {{ provider?: string, slot?: string }} spec.context - the dispatch's pin record.
 * @returns {Promise<{ value: string, source: string } | undefined>} the resolved credential.
 */
async function resolveFromPool({ pool, ref, resolveRef, report, context }) {
  for (let attempt = 0; attempt <= pool.keys.length; attempt++) {
    const { key, exhausted } = pool.pick()
    if (key === undefined) return undefined
    if (exhausted) report('pool-exhausted', { provider: context.provider, ref, slot: key })
    const hit = await resolveRef(key)
    if (hit !== undefined && hit.value !== '') {
      // The pin carries the served slot, so the failure that may follow — and any
      // concurrent request's failure — is attributed to the slot that caused it.
      context.slot = key
      return hit
    }
    report('missing-slot', { provider: context.provider, ref, slot: key, cooldownMs: pool.cool(key, pool.cooldownMs) })
    if (pool.everyCooling()) break
  }
  return undefined
}

/**
 * Install the rotation patch on the credential service.
 *
 * @param {object} spec - dependencies.
 * @param {object} spec.credentials - the credential service, as this plugin's context sees it.
 * @param {import('node:async_hooks').AsyncLocalStorage<{ provider?: string, slot?: string }>} spec.als
 *   the per-dispatch pin.
 * @param {() => { pools: Map<string, any> }} spec.build - the current rotation runtime.
 * @param {(kind: string, fields?: object) => boolean} spec.report - event sink.
 * @returns {() => void} the disposer restoring the pre-patch resolution.
 */
export function installResolvePatch({ credentials, als, build, report }) {
  const previous = credentials.resolve.bind(credentials)

  credentials.resolve = async (ref) => {
    const context = als.getStore()
    if (context === undefined) return previous(ref)
    const pool = build().pools.get(String(ref))
    if (pool === undefined) return previous(ref)
    return resolveFromPool({ pool, ref: String(ref), resolveRef: previous, report, context })
  }

  return () => delete credentials.resolve
}
