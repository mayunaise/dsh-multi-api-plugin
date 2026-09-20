// Unit tests for the event layer: the log line a rotation produces, and the
// guarantee that it never carries a credential value.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createReporter, describeEvent, keyTail } from '../lib/events.js'

test('a reference is shortened to its tail for a log line', () => {
  assert.equal(keyTail('ACME_GATEWAY_KEY_1'), '…KEY_1')
  assert.equal(keyTail('SHORT'), 'SHORT')
  assert.equal(keyTail(undefined), '')
})

test('every rendered line names the reference and only the slot tail', () => {
  const secret = 'sk-do-not-log-me-abcdef123456'
  const line = describeEvent('switch', {
    provider: 'acme-gateway',
    ref: 'ACME_GATEWAY_KEY',
    slot: 'ACME_GATEWAY_KEY_2',
    code: 'RATE_LIMIT',
    cooldownMs: 60_000,
    attempt: 1,
  })
  assert.match(line, /acme-gateway/)
  assert.match(line, /ACME_GATEWAY_KEY/)
  assert.match(line, /RATE_LIMIT/)
  assert.match(line, /60s/)
  assert.equal(line.includes(secret), false)
  assert.equal(line.includes('ACME_GATEWAY_KEY_2'), false, 'the slot appears only as a tail')
  assert.match(line, /…KEY_2/)
})

test('the reporter collapses a repeated subject and re-reports after the window', () => {
  let clock = 0
  const lines = []
  const report = createReporter({
    logger: { warn: (message) => lines.push(message) },
    now: () => clock,
    dedupMs: 1000,
  })
  assert.equal(report('switch', { ref: 'ACME_KEY', slot: 'ACME_KEY_1', code: 'RATE_LIMIT' }), true)
  assert.equal(report('switch', { ref: 'ACME_KEY', slot: 'ACME_KEY_1', code: 'RATE_LIMIT' }), false)
  clock = 999
  assert.equal(report('switch', { ref: 'ACME_KEY', slot: 'ACME_KEY_1', code: 'RATE_LIMIT' }), false)
  clock = 1000
  assert.equal(report('switch', { ref: 'ACME_KEY', slot: 'ACME_KEY_1', code: 'RATE_LIMIT' }), true)
  assert.equal(report('switch', { ref: 'ACME_KEY', slot: 'ACME_KEY_2', code: 'RATE_LIMIT' }), true, 'a different slot is a different subject')
  assert.equal(lines.length, 3)
  assert.ok(lines.every((line) => line.startsWith('[dsh-multi-api-plugin] ')))
})
