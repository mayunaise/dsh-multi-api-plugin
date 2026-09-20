/**
 * One key pool: an ordered list of credential references plus the cooldown state
 * of a single process run.
 *
 * The module is a pure state machine — the clock is injected, nothing here does
 * I/O or logging — so the selection policy is testable without a runtime.
 *
 * @module dsh-multi-api-plugin/pool
 */

/**
 * Failure codes that move a request to the next slot by default.
 *
 * `RATE_LIMIT` and `QUOTA` say the account behind the key is out of budget;
 * `AUTH` says the key itself is rejected. The retryable-but-not-attributable
 * codes (`SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`) are deliberately
 * absent: another key is unlikely to help, and `@deepseek-ai/dsh-llm-retry`
 * already owns the step-level backoff for them.
 */
export const DEFAULT_SWITCH_CODES = Object.freeze(['RATE_LIMIT', 'QUOTA', 'AUTH'])

/** Characters of a slot reference kept when one is named in a log line. */
export const KEY_TAIL_LENGTH = 5

/**
 * @typedef {object} PoolSpec
 * @property {string} ref - the credential reference this pool answers for
 * @property {string[]} keys - slot references, in rotation order
 * @property {number} cooldownMs - cooldown applied to a slot that failed
 * @property {number} maxCooldownMs - upper bound for any cooldown
 * @property {string[]} switchCodes - failure codes that move to the next slot
 * @property {() => number} [now] - clock, for tests
 */

/**
 * @typedef {object} Pick
 * @property {string | undefined} key - the slot to use; undefined when the pool has no slot
 * @property {boolean} exhausted - every slot was cooling, so `key` is the soonest one
 */

/**
 * Create one pool.
 *
 * @param {PoolSpec} spec - pool definition and policy.
 * @returns {object} the pool: `pick`, `cool`, `switches`, `isCooling`, `health`, `snapshot`.
 */
export function createPool(spec) {
  const { ref, keys, cooldownMs, maxCooldownMs, switchCodes, now = Date.now } = spec
  const cooling = new Map()
  const switches = new Set(switchCodes)
  const known = new Set(keys)
  let pointer = 0

  /** @param {string} key - a slot reference. @returns {boolean} whether it is cooling now. */
  const isCooling = (key) => (cooling.get(key) ?? 0) > now()

  /**
   * Choose the slot for one resolution: the next non-cooling slot after the
   * pointer, or — when every slot is cooling — the slot that becomes ready
   * soonest, flagged `exhausted`.
   *
   * Answering rather than refusing is deliberate. A refusal here would replace
   * the provider's own failure with a rotation error, and it would break the
   * loop-level retry: `@deepseek-ai/dsh-llm-retry` re-runs a failed step, which
   * re-enters resolution, so the pool must still have an answer to give.
   *
   * @returns {Pick} the selection.
   */
  function pick() {
    const count = keys.length
    if (count === 0) return { key: undefined, exhausted: false }
    for (let offset = 0; offset < count; offset++) {
      const index = (pointer + offset) % count
      const key = keys[index]
      if (isCooling(key)) continue
      pointer = (index + 1) % count
      return { key, exhausted: false }
    }
    let soonest = keys[0]
    for (const key of keys) {
      if ((cooling.get(key) ?? 0) < (cooling.get(soonest) ?? 0)) soonest = key
    }
    return { key: soonest, exhausted: true }
  }

  /**
   * Put one slot on cooldown, capped by `maxCooldownMs`.
   *
   * @param {string} key - the slot that failed; an unknown slot is ignored.
   * @param {number} ms - requested cooldown, typically the provider's own hint.
   * @returns {number} the cooldown actually applied, in milliseconds.
   */
  function cool(key, ms) {
    if (typeof key !== 'string' || !known.has(key)) return 0
    const applied = Math.min(Math.max(ms, 0), maxCooldownMs)
    const until = now() + applied
    if (until > (cooling.get(key) ?? 0)) cooling.set(key, until)
    return applied
  }

  /** @returns {boolean} whether every slot is cooling. */
  const everyCooling = () => keys.every((key) => isCooling(key))

  /** @returns {{ total: number, cooling: number }} slot counts, for diagnostics. */
  function health() {
    const cooling0 = keys.filter((key) => isCooling(key)).length
    return { total: keys.length, cooling: cooling0 }
  }

  /** @returns {object} a detached view of this pool's state. */
  function snapshot() {
    return {
      ref,
      keys: [...keys],
      cooldownMs,
      maxCooldownMs,
      switchCodes: [...switches],
      coolingUntil: Object.fromEntries(keys.map((key) => [key, cooling.get(key) ?? 0])),
      pointer,
    }
  }

  return { ref, keys, switches, pick, cool, everyCooling, isCooling, health, snapshot }
}
