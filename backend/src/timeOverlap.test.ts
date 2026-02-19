import assert from 'node:assert/strict';
import test from 'node:test';
import { overlapsHalfOpenIntervals } from './timeOverlap';

test('touching interval boundaries are not treated as overlap', () => {
  assert.equal(overlapsHalfOpenIntervals(8 * 60, 14 * 60, 14 * 60, 16 * 60), false);
  assert.equal(overlapsHalfOpenIntervals(14 * 60, 16 * 60, 8 * 60, 14 * 60), false);
});

test('real intersections are treated as overlap', () => {
  assert.equal(overlapsHalfOpenIntervals(8 * 60, 14 * 60, 13 * 60 + 59, 16 * 60), true);
});

test('invalid or empty intervals are never treated as overlap', () => {
  assert.equal(overlapsHalfOpenIntervals(10 * 60, 10 * 60, 10 * 60, 12 * 60), false);
  assert.equal(overlapsHalfOpenIntervals(12 * 60, 10 * 60, 10 * 60, 12 * 60), false);
});
