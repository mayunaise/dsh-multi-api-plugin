/**
 * Structured rotation events and their log lines.
 *
 * Everything this plugin reports passes through here so that one rule holds
 * everywhere: a log line may name a credential *reference* and a short tail,
 * never a secret value. Repeated subjects (one key failing on every request of a
 * burst) collapse into one line per window instead of flooding the log.
 *
 * @module dsh-multi-api-plugin/events
 */

import { KEY_TAIL_LENGTH } from './pool.js'

/**
 * The last few characters of a reference, the most a log line may carry.
 *
 * @param {string} ref - the reference to shorten.
 * @returns {string} a short, value-free handle for logs.
 */
export function keyTail(ref) {
  const text = String(ref ?? '')
  return text.length <= KEY_TAIL_LENGTH ? text : `…${text.slice(-KEY_TAIL_LENGTH)}`
}

/**
 * Render one event as a single log line.
 *
 * @param {string} kind - event kind, e.g. `switch`.
 * @param {object} fields - event fields.
 * @returns {string} the log line, never carrying a credential value.
 */
export function describeEvent(kind, fields) {
  const where = fields.provider === undefined ? '' : ` ${fields.provider}`
  switch (kind) {
    case 'switch':
      return `${where}: key ${keyTail(fields.slot)} failed with ${fields.code} — retrying on the next slot of ${fields.ref} (cooldown ${Math.round((fields.cooldownMs ?? 0) / 1000)}s, attempt ${fields.attempt})`
    case 'pool-exhausted':
      return `${where}: every slot of ${fields.ref} is cooling; answering with ${keyTail(fields.slot)} because refusing would bury the provider's own error`
    case 'missing-slot':
      return `${where}: slot ${fields.ref}/${keyTail(fields.slot)} resolves to no value — skipped and parked for ${Math.round((fields.cooldownMs ?? 0) / 1000)}s`
    case 'pool-empty':
      return `pool ${fields.ref} has no slot; rotation stays off for every route that names it (add reference names under pools.${fields.ref}.keys)`
    case 'model-pool-empty':
      return `pool ${fields.ref} names no slot for model ${fields.model}; that model draws from the pool's own slots instead (add reference names under pools.${fields.ref}.models.${fields.model}.keys)`
    case 'invalid-ref':
    case 'patch-failed':
      return `${fields.message}`
    default:
      return `${kind}${where} ${JSON.stringify(fields)}`
  }
}

/**
 * Create the reporter used across the plugin.
 *
 * @param {object} spec - dependencies.
 * @param {{ warn: (message: string) => void }} spec.logger - the host logger.
 * @param {() => number} [spec.now] - clock, for tests.
 * @param {number} [spec.dedupMs] - suppression window per subject; 0 reports every event.
 * @returns {(kind: string, fields?: object) => boolean} reports one event; true when it was emitted.
 */
export function createReporter({ logger, now = Date.now, dedupMs = 300_000 }) {
  const lastSeen = new Map()

  return function report(kind, fields = {}) {
    if (dedupMs > 0) {
      const subject = `${kind}:${fields.provider ?? ''}:${fields.ref ?? ''}:${fields.model ?? ''}:${fields.slot ?? ''}`
      const seenAt = lastSeen.get(subject)
      if (seenAt !== undefined && now() - seenAt < dedupMs) return false
      lastSeen.set(subject, now())
    }
    logger.warn(`[dsh-multi-api-plugin] ${describeEvent(kind, fields)}`)
    return true
  }
}
