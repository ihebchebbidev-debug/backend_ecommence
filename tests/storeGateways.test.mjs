import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMode, flouciIsPaid, clictopayHasError } from '../src/functions/_shared/storeGateways.js';

test('mode accepts only test or live', () => {
  assert.equal(normalizeMode('test'), 'test');
  assert.equal(normalizeMode('sandbox'), 'test');
  assert.equal(normalizeMode('live'), 'live');
  assert.equal(normalizeMode('staging'), null);
});
test('Flouci paid needs both success flag and SUCCESS status', () => {
  assert.equal(flouciIsPaid({ success: true, result: { status: 'SUCCESS' } }), true);
  assert.equal(flouciIsPaid({ success: false, result: { status: 'SUCCESS' } }), false);
  assert.equal(flouciIsPaid({ success: true, result: { status: 'PENDING' } }), false);
});
test('ClicToPay non-zero error code is a failure', () => {
  assert.equal(clictopayHasError({ errorCode: '0', orderStatus: 2 }), false);
  assert.equal(clictopayHasError({ errorCode: '2', orderStatus: 2 }), true);
  assert.equal(clictopayHasError({ orderStatus: 2 }), false);
});
