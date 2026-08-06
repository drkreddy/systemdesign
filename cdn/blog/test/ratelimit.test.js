/* Simulator tests. Run with: node blog/test/ratelimit.test.js
 *
 * These exist because post 2's whole claim is a specific number — that a fixed
 * window admits exactly twice its limit across a boundary. If that drifts, the
 * post becomes wrong, and nothing in a browser would tell us.
 */
import {
  fixedWindow, slidingLog, slidingCounter, tokenBucket,
  steady, burst, boundaryBurst, allowedCount,
} from '../public/assets/ratelimit.js';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}` +
              (ok ? '' : `\n         got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

const LIMIT = 10, WINDOW = 60000;
const cfg = { limit: LIMIT, windowMs: WINDOW };

console.log('\n— the boundary burst, which post 2 is built on —');
const bb = boundaryBurst(LIMIT, WINDOW);
check('20 requests, two seconds apart, across a window edge', bb.length, 20);
check('fixed window admits ALL 20 — twice the limit', allowedCount(fixedWindow(bb, cfg)), 20);
check('sliding log admits exactly the limit',         allowedCount(slidingLog(bb, cfg)), 10);

// Not <= limit. The counter weights the previous window by overlap and assumes
// its traffic was evenly spread; when it all arrived at the very end, the
// estimate reads low and one extra request slips through. That overshoot is the
// documented cost of storing two integers instead of every timestamp.
check('sliding counter overshoots by exactly one',    allowedCount(slidingCounter(bb, cfg)), 11);

console.log('\n— steady traffic at exactly the limit is never blocked —');
const st = steady(10, 6000);
check('fixed window',    allowedCount(fixedWindow(st, cfg)), 10);
check('sliding log',     allowedCount(slidingLog(st, cfg)), 10);
check('sliding counter', allowedCount(slidingCounter(st, cfg)), 10);

console.log('\n— token bucket —');
check('a cold burst spends exactly the bucket',
      allowedCount(tokenBucket(burst(20, 0), { ratePerSec: 1, burst: 5 })), 5);
check('arrivals at the refill rate all pass',
      allowedCount(tokenBucket(steady(10, 1000), { ratePerSec: 1, burst: 5 })), 10);
check('arrivals at twice the rate are throttled',
      allowedCount(tokenBucket(steady(10, 500), { ratePerSec: 1, burst: 5 })) < 10, true);

console.log('\n— edge cases —');
check('no events',     fixedWindow([], cfg).length, 0);
check('limit of zero', allowedCount(fixedWindow(burst(5, 0), { limit: 0, windowMs: 1000 })), 0);
check('a long pause resets the window',
      allowedCount(fixedWindow([0, WINDOW * 5], { limit: 1, windowMs: WINDOW })), 2);
check('a skipped window does not carry a stale previous count',
      allowedCount(slidingCounter([0, WINDOW * 5], { limit: 1, windowMs: WINDOW })), 2);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
