/* Widgets for the rate-limiting lab.
 *
 * These are deliberately separate from lab.js: those widgets talk to the edge
 * and need a recorded-first fallback, while these are pure arithmetic running
 * in the reader's browser. No network means no loading state, no rate limit, no
 * failure mode — the controls can respond on every keystroke.
 */

import {
  ALGORITHMS, compare, allowedCount, distributed,
  steady, burst, boundaryBurst,
} from './ratelimit.js';

const PATTERNS = {
  boundary: {
    label: 'Burst either side of a window edge',
    build: (limit, windowMs) => boundaryBurst(limit, windowMs),
    note: 'A full limit just before the boundary, another full limit just after.',
  },
  steady: {
    label: 'Steady, exactly at the limit',
    build: (limit, windowMs) => steady(limit, Math.floor(windowMs / limit)),
    note: 'Evenly spaced traffic that should never be refused.',
  },
  bursty: {
    label: 'One large burst, then quiet',
    build: (limit, windowMs) => burst(limit * 2, Math.floor(windowMs / 2)),
    note: 'Twice the limit arriving at once, mid-window.',
  },
  rampup: {
    label: 'Gradual ramp-up',
    build: (limit, windowMs) => steady(limit * 2, Math.floor(windowMs / (limit * 2.5))),
    note: 'Traffic arriving steadily but faster than the limit allows.',
  },
};

/* ------------------------------------------------------------- rendering */

/** Groups simultaneous events so ten requests at one instant read as ten
 *  stacked marks rather than one mark hiding nine others. */
function groupByTime(decisions) {
  const groups = new Map();
  for (const d of decisions) {
    if (!groups.has(d.t)) groups.set(d.t, []);
    groups.get(d.t).push(d);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

function timelineSvg(runs, { windowMs, maxT }) {
  const W = 600, PAD_L = 122, PAD_R = 16;
  const ROW = 46, TOP = 22;
  const span = Math.max(maxT, windowMs) * 1.04;
  const x = (t) => PAD_L + (t / span) * (W - PAD_L - PAD_R);
  const H = TOP + runs.length * ROW + 16;

  // Window boundaries: the thing fixed windows reset on, and the thing an
  // attacker aims at. Worth drawing even for algorithms that ignore them.
  let grid = '';
  for (let b = windowMs; b < span; b += windowMs) {
    grid += `<line x1="${x(b).toFixed(1)}" y1="${TOP - 8}" x2="${x(b).toFixed(1)}" y2="${H - 18}"
             stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="2 4" opacity=".5"/>
             <text x="${x(b).toFixed(1)}" y="${H - 6}" class="svg-label" text-anchor="middle">${b / 1000}s</text>`;
  }

  const rows = runs.map((run, i) => {
    const yBase = TOP + i * ROW + 30;
    const groups = groupByTime(run.decisions);
    const marks = groups.map(([t, ds]) => {
      const cx = x(t);
      return ds.map((d, j) => {
        const y = yBase - j * 3.4 - 3;
        return `<rect x="${(cx - 2.5).toFixed(1)}" y="${y.toFixed(1)}" width="5" height="2.6" rx="1"
                 fill="${d.allowed ? 'var(--edge)' : 'var(--origin)'}"/>`;
      }).join('');
    }).join('');
    const n = allowedCount(run.decisions);
    const total = run.decisions.length;
    const over = n > run.limit;
    return `
      <text x="0" y="${yBase - 12}" class="svg-label-strong">${run.label}</text>
      <text x="0" y="${yBase + 2}" class="svg-label" fill="${over ? 'var(--origin)' : 'var(--ink-3)'}">
        ${n} of ${total} allowed</text>
      <line x1="${PAD_L}" y1="${yBase + 1}" x2="${W - PAD_R}" y2="${yBase + 1}"
            stroke="var(--rule)" stroke-width="1"/>
      ${marks}`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Timeline comparing which requests each algorithm allowed">
    ${grid}${rows}
  </svg>`;
}

/* --------------------------------------------------------------- mounting */

function mountCompare(el) {
  const limit = Number(el.dataset.limit || 10);
  const windowSec = Number(el.dataset.window || 60);
  const windowMs = windowSec * 1000;
  const algos = (el.dataset.algorithms || 'fixed-window,sliding-log,sliding-counter').split(',');
  const patternKeys = (el.dataset.patterns || 'boundary,steady,bursty').split(',');

  el.innerHTML = `
    <div class="lab-head">
      <h4>${el.dataset.title || 'Compare algorithms'}</h4>
      <label class="ctl">pattern
        <select class="pattern">${patternKeys.map((k) =>
          `<option value="${k}">${PATTERNS[k].label}</option>`).join('')}</select>
      </label>
    </div>
    <div class="lab-body"></div>
    <div class="lab-note"></div>`;

  const body = el.querySelector('.lab-body');
  const note = el.querySelector('.lab-note');
  const select = el.querySelector('.pattern');

  const draw = () => {
    const p = PATTERNS[select.value];
    const events = p.build(limit, windowMs);
    const runs = compare(events, { limit, windowMs, ratePerSec: limit / windowSec, burst: limit }, algos)
      .map((r) => ({ ...r, limit }));
    const maxT = Math.max(...events, windowMs);
    body.innerHTML = timelineSvg(runs, { windowMs, maxT });
    const worst = runs.reduce((a, b) => allowedCount(a.decisions) > allowedCount(b.decisions) ? a : b);
    note.innerHTML = `${p.note} Limit ${limit} per ${windowSec}s. ` +
      `<strong>${worst.label}</strong> allowed the most: ${allowedCount(worst.decisions)}.`;
  };

  select.addEventListener('change', draw);
  draw();
}

function mountBucket(el) {
  el.innerHTML = `
    <div class="lab-head">
      <h4>${el.dataset.title || 'Token bucket'}</h4>
      <label class="ctl">refill/sec <input class="rate" type="range" min="1" max="10" value="2"></label>
      <label class="ctl">bucket <input class="burst" type="range" min="1" max="20" value="8"></label>
    </div>
    <div class="lab-body"></div>
    <div class="lab-note"></div>`;

  const body = el.querySelector('.lab-body');
  const note = el.querySelector('.lab-note');
  const rateEl = el.querySelector('.rate');
  const burstEl = el.querySelector('.burst');

  const draw = () => {
    const ratePerSec = Number(rateEl.value);
    const capacity = Number(burstEl.value);
    // A burst of 20 at once, then steady arrivals — the shape that shows a
    // bucket draining and refilling rather than a single flat verdict.
    const events = [...burst(20, 0), ...steady(20, 400, 3000)];
    const decisions = ALGORITHMS['token-bucket'].fn(events, { ratePerSec, burst: capacity });
    body.innerHTML = timelineSvg(
      [{ label: 'Token bucket', decisions, limit: capacity }],
      { windowMs: 5000, maxT: Math.max(...events) }
    );
    const allowed = allowedCount(decisions);
    note.innerHTML = `Bucket holds <strong>${capacity}</strong>, refills at ` +
      `<strong>${ratePerSec}/s</strong>. Of 40 requests, ${allowed} passed. ` +
      `The opening burst spends the bucket; everything after is paced by the refill rate.`;
  };

  rateEl.addEventListener('input', draw);
  burstEl.addEventListener('input', draw);
  draw();
}

function mountDistributed(el) {
  const limit = Number(el.dataset.limit || 10);
  const windowSec = Number(el.dataset.window || 60);
  const windowMs = windowSec * 1000;

  el.innerHTML = `
    <div class="lab-head">
      <h4>${el.dataset.title || 'One limit, several servers'}</h4>
      <label class="ctl">servers <input class="inst" type="range" min="1" max="8" value="4"></label>
      <label class="ctl">routing
        <select class="strategy">
          <option value="round-robin">round robin</option>
          <option value="random">random</option>
          <option value="sticky">sticky by client</option>
        </select>
      </label>
    </div>
    <div class="lab-body"></div>
    <div class="lab-note"></div>`;

  const body = el.querySelector('.lab-body');
  const note = el.querySelector('.lab-note');
  const instEl = el.querySelector('.inst');
  const stratEl = el.querySelector('.strategy');

  const draw = () => {
    const instances = Number(instEl.value);
    const strategy = stratEl.value;
    // Far more traffic than the limit permits, so the only thing varying is how
    // many servers get to say yes.
    const events = steady(120, Math.floor(windowMs / 160));
    const r = distributed(events, { limit, windowMs }, { instances, strategy });
    const runs = r.perInstance.map((decisions, i) => ({
      label: `server ${i + 1}`, decisions, limit,
    }));
    body.innerHTML = timelineSvg(runs, { windowMs, maxT: Math.max(...events) });
    const over = r.totalAllowed > limit;
    note.innerHTML =
      `Configured limit: <strong>${limit}</strong> per ${windowSec}s. ` +
      `Across ${instances} server${instances > 1 ? 's' : ''} the client actually got ` +
      `<strong style="color:${over ? 'var(--origin)' : 'var(--edge)'}">${r.totalAllowed}</strong>` +
      (over ? ` — ${(r.totalAllowed / limit).toFixed(0)}x the limit.` : ' — correct.');
  };

  instEl.addEventListener('input', draw);
  stratEl.addEventListener('change', draw);
  draw();
}

/* The only widget here that touches a server. Everything else is arithmetic;
 * being genuinely refused is not, so this one fires real requests at a real
 * limiter and shows the headers that come back. It WILL get you a 429 — that
 * is the demonstration, not a failure. */
const PLAY = 'https://play.drkreddy.com';

function visitorId() {
  const KEY = 'cdn-lab-visitor';
  let v = null;
  try { v = localStorage.getItem(KEY); } catch { /* private mode */ }
  if (!v) {
    v = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    try { localStorage.setItem(KEY, v); } catch { /* ignore */ }
  }
  return v;
}

function mountLive(el) {
  const rate = Number(el.dataset.rate || 1);
  const bucket = Number(el.dataset.burst || 5);
  el.innerHTML = `
    <div class="lab-head">
      <h4>${el.dataset.title || 'A limiter you can actually trip'}</h4>
      <button class="run" type="button">Send 8 requests</button>
    </div>
    <div class="lab-body"><p style="font-size:.9rem;color:var(--ink-2);margin:0">
      Bucket of ${bucket}, refilling at ${rate}/second. The first few will pass and
      the rest will be refused with a real <code>429</code>. Nothing breaks — waiting
      a second or two restores your budget.</p></div>
    <div class="lab-note"></div>`;

  const body = el.querySelector('.lab-body');
  const note = el.querySelector('.lab-note');
  const btn = el.querySelector('.run');

  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Sending…';
    body.innerHTML = '<div class="rows"></div>';
    const rows = body.querySelector('.rows');
    let allowed = 0, refused = 0, lastRetry = null;

    for (let i = 1; i <= 8; i++) {
      let res;
      try {
        res = await fetch(`${PLAY}/rate-limit/token-bucket?rate=${rate}&burst=${bucket}&v=${visitorId()}`,
                          { mode: 'cors', cache: 'no-store' });
      } catch {
        note.textContent = 'Could not reach the limiter. The algorithms above still work — they run here.';
        break;
      }
      const ok = res.status === 200;
      ok ? allowed++ : refused++;
      const remaining = res.headers.get('x-ratelimit-remaining');
      const retry = res.headers.get('retry-after');
      if (retry) lastRetry = retry;
      rows.insertAdjacentHTML('beforeend', `
        <div class="r">
          <span class="idx">${i}</span>
          <span><span class="chip ${ok ? 'hit' : 'miss'}">${res.status}</span></span>
          <span style="font-size:.78rem;color:var(--ink-2)">
            ${remaining !== null ? `${remaining} left` : ''}${retry ? ` · retry after ${retry}s` : ''}</span>
          <span class="ms"></span>
        </div>`);
    }

    note.innerHTML = `<strong>${allowed}</strong> allowed, <strong>${refused}</strong> refused.` +
      (lastRetry ? ` The server asked you to wait <strong>${lastRetry}s</strong> — and it means it.
       Wait that long and the next request succeeds.` : '');
    btn.disabled = false; btn.textContent = 'Send 8 requests';
  });
}

const MOUNTS = {
  'rl-compare': mountCompare,
  'rl-bucket': mountBucket,
  'rl-distributed': mountDistributed,
  'rl-live': mountLive,
};

document.querySelectorAll('.lab[data-widget^="rl-"]').forEach((el) => {
  const fn = MOUNTS[el.dataset.widget];
  if (fn) fn(el);
});
