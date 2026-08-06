import { defineLab } from '../core.js';

// The rate-limiting lab. Only one experiment needs a server: the algorithms
// themselves are deterministic arithmetic and run in the reader's browser.
// What cannot be simulated is being genuinely refused — a real 429, a real
// Retry-After that is actually correct — so that is what lives here.
export default defineLab('rate-limit', {
  'token-bucket': {
    kind: 'local',
    handler: 'tokenBucket',
    params: {
      // Small on purpose: a reader should be able to empty the bucket in a few
      // clicks and watch it refill within the time they will actually wait.
      rate:  { type: 'int', min: 1, max: 5,  default: 1 },
      burst: { type: 'int', min: 1, max: 10, default: 5 },
    },
  },
});
