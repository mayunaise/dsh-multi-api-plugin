// Unit tests for the pool state machine: selection, cooldown, exhaustion.
// The clock is injected, so every case is deterministic.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SWITCH_CODES, createPool } from '../lib/pool.js'

function harness({ keys = ['K1', 'K2'], cooldownMs = 1000, maxCooldownMs = 10_000, switchCodes = [...DEFAULT_SWITCH_CODES] } = {}) {
  let clock = 0
  const pool = createPool({ ref: 'ACME_KEY', keys, cooldownMs, maxCooldownMs, switchCodes, now: () => clock })
  return { pool, advance: (ms) => (clock += ms) }
}

test('rotates round-robin over healthy slots', () => {
  const { pool } = harness()
  assert.equal(pool.pick().key, 'K1')
  assert.equal(pool.pick().key, 'K2')
  assert.equal(pool.pick().key, 'K1')
})

test('skips a cooling slot and comes back to it when the cooldown expires', () => {
  const { pool, advance } = harness()
  assert.equal(pool.pick().key, 'K1')
  pool.cool('K1', 1000)
  assert.equal(pool.pick().key, 'K2')
  assert.equal(pool.pick().key, 'K2', 'K1 stays out while cooling')
  advance(1000)
  assert.equal(pool.pick().key, 'K1')
})

test('answers with the soonest-expiring slot when every slot is cooling', () => {
  const { pool, advance } = harness()
  pool.cool('K1', 5000)
  pool.cool('K2', 1000)
  const pick = pool.pick()
  assert.deepEqual(pick, { key: 'K2', exhausted: true })
  assert.equal(pool.everyCooling(), true)
  advance(1000)
  assert.equal(pool.everyCooling(), false)
  assert.deepEqual(pool.pick(), { key: 'K2', exhausted: false })
})

test('an empty pool selects nothing', () => {
  const { pool } = harness({ keys: [] })
  assert.deepEqual(pool.pick(), { key: undefined, exhausted: false })
})

test('cooling caps at maxCooldownMs and never shortens an existing cooldown', () => {
  const { pool, advance } = harness({ cooldownMs: 1000, maxCooldownMs: 2000 })
  assert.equal(pool.cool('K1', 60_000), 2000, 'a long provider hint is capped')
  assert.equal(pool.health().cooling, 1)
  assert.equal(pool.cool('K1', 500), 500, 'a shorter cooldown does not shorten the parked slot')
  advance(1500)
  assert.equal(pool.isCooling('K1'), true)
  advance(500)
  assert.equal(pool.isCooling('K1'), false)
})

test('cooling an unknown slot is a no-op', () => {
  const { pool } = harness()
  assert.equal(pool.cool('not-a-slot', 1000), 0)
  assert.equal(pool.cool(undefined, 1000), 0)
  assert.equal(pool.health().cooling, 0)
})

test('switch codes are the pool’s own set', () => {
  const { pool } = harness({ switchCodes: ['RATE_LIMIT'] })
  assert.equal(pool.switches.has('RATE_LIMIT'), true)
  assert.equal(pool.switches.has('AUTH'), false)
  assert.deepEqual([...DEFAULT_SWITCH_CODES], ['RATE_LIMIT', 'QUOTA', 'AUTH'])
})

test('snapshot reports the pool without leaking anything else', () => {
  const { pool } = harness()
  pool.cool('K1', 1000)
  const snapshot = pool.snapshot()
  assert.equal(snapshot.ref, 'ACME_KEY')
  assert.deepEqual(snapshot.keys, ['K1', 'K2'])
  assert.equal(snapshot.coolingUntil.K1, 1000)
  assert.equal(snapshot.coolingUntil.K2, 0)
})
