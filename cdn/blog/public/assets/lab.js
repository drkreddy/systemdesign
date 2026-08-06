/* Widget runtime.
 *
 * Every widget renders from RECORDED data first, so a page is instant, works
 * offline, and touches no infrastructure. "Run it live" then fires genuine
 * requests at play.drkreddy.com and relabels the result.
 *
 * Recorded-first is a correctness decision as much as a safety one: a reader
 * should never meet an empty widget because a free-tier origin was asleep or a
 * rate limit had been reached.
 */

const PLAY = 'https://play.drkreddy.com';

/* A per-reader id, folded into the cache key at the edge so two people running
 * the same experiment cannot corrupt each other's MISS/HIT sequence. It does
 * NOT reach the origin URL, so isolating readers costs no extra origin load. */
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

class Halt extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

async function callPlay(experiment, params = {}) {
  const url = new URL(`${PLAY}/${experiment}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('v', visitorId());

  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { mode: 'cors', cache: 'no-store' });
  } catch {
    throw new Halt('offline', 'Could not reach the live lab. Showing the recorded run instead.');
  }
  const ms = Math.round(performance.now() - t0);

  if (res.status === 503) {
    throw new Halt('disabled', 'Live experiments are switched off right now. Showing the recorded run instead.');
  }
  if (res.status === 429) {
    throw new Halt('ratelimited', 'That is a lot of requests — the rate limit kicked in. Wait ten seconds and try again.');
  }

  let body = null;
  try { body = await res.json(); } catch { /* some experiments return non-JSON */ }

  return {
    ms,
    status: res.status,
    // These are readable only because the edge sends Access-Control-Expose-Headers.
    // Without that, browser JS sees the body and nothing else.
    cache: res.headers.get('x-play-cache') || '—',
    age: res.headers.get('x-play-age'),
    originHit: res.headers.get('x-origin-hit'),
    clamped: res.headers.get('x-play-clamped'),
    body,
  };
}

/* ---------------------------------------------------------------- rendering */

const chipClass = (s) => ({ HIT: 'hit', MISS: 'miss', STALE: 'stale' }[s] || 'none');

function rowsHtml(rows, maxMs) {
  const cap = Math.max(maxMs, ...rows.map((r) => r.ms), 1);
  return `<div class="rows">${rows.map((r, i) => `
    <div class="r">
      <span class="idx">${i + 1}</span>
      <span><span class="chip ${chipClass(r.cache)}">${r.cache}</span></span>
      <span class="bar ${chipClass(r.cache)}" style="width:${Math.max(2, (r.ms / cap) * 100)}%"></span>
      <span class="ms">${r.ms}ms</span>
    </div>`).join('')}</div>`;
}

function readout(items) {
  return `<div class="readout">${items.map((i) => `
    <div><dt>${i.label}</dt><dd class="${i.tone || ''}">${i.value}</dd></div>`).join('')}</div>`;
}

function banner(msg, kind = '') {
  return `<div class="banner ${kind}">${msg}</div>`;
}

/* ----------------------------------------------------------------- widgets */

const WIDGETS = {
  /* Fire N requests at one experiment and watch MISS become HIT. The origin
     counter is the proof: if it stops moving, the edge is answering. */
  sequence: {
    recorded: (el) => {
      const slow = el.dataset.slow === 'true';
      return slow
        ? [{ cache: 'MISS', ms: 1180 }, { cache: 'HIT', ms: 61 }, { cache: 'HIT', ms: 48 }, { cache: 'HIT', ms: 52 }]
        : [{ cache: 'MISS', ms: 402 }, { cache: 'HIT', ms: 58 }, { cache: 'HIT', ms: 44 }, { cache: 'HIT', ms: 49 }];
    },
    render(el, rows, live) {
      const misses = rows.filter((r) => r.cache === 'MISS').length;
      const first = rows[0]?.ms || 0;
      const rest = rows.slice(1);
      const avg = rest.length ? Math.round(rest.reduce((a, r) => a + r.ms, 0) / rest.length) : 0;
      el.querySelector('.lab-body').innerHTML =
        rowsHtml(rows, 0) +
        readout([
          { label: 'first request', value: `${first}ms`, tone: 'warn' },
          { label: 'once cached', value: `${avg}ms`, tone: 'good' },
          { label: 'reached the origin', value: `${misses} of ${rows.length}`, tone: misses <= 1 ? 'good' : 'warn' },
        ]);
    },
    async live(el) {
      const exp = el.dataset.experiment;
      const runs = Number(el.dataset.runs || 4);
      const params = el.dataset.ms ? { ms: el.dataset.ms } : {};
      const rows = [];
      for (let i = 0; i < runs; i++) {
        const r = await callPlay(exp, params);
        rows.push({ cache: r.cache, ms: r.ms });
        this.render(el, rows, true);
      }
      return rows;
    },
  },

  /* Add a tracking parameter and watch one logical object shatter into several
     cached copies — unless the edge normalises the key, which ours does. */
  cachekey: {
    recorded: () => ([
      { label: 'plain URL', cache: 'MISS', ms: 388 },
      { label: '+ utm_source=twitter', cache: 'HIT', ms: 54 },
      { label: '+ utm_source=facebook', cache: 'HIT', ms: 47 },
      { label: '+ fbclid=abc123', cache: 'HIT', ms: 51 },
    ]),
    render(el, rows) {
      const hits = rows.filter((r) => r.cache === 'HIT').length;
      el.querySelector('.lab-body').innerHTML =
        `<div class="rows">${rows.map((r) => `
          <div class="r">
            <span class="idx"></span>
            <span><span class="chip ${chipClass(r.cache)}">${r.cache}</span></span>
            <span style="font-size:.78rem;color:var(--ink-2)">${r.label}</span>
            <span class="ms">${r.ms}ms</span>
          </div>`).join('')}</div>` +
        readout([
          { label: 'served from cache', value: `${hits} of ${rows.length}`, tone: hits >= rows.length - 1 ? 'good' : 'warn' },
          { label: 'origin fetches', value: `${rows.length - hits}`, tone: rows.length - hits <= 1 ? 'good' : 'warn' },
        ]);
    },
    async live(el) {
      const variants = [
        { label: 'plain URL', params: {} },
        { label: '+ utm_source=twitter', params: { utm_source: 'twitter' } },
        { label: '+ utm_source=facebook', params: { utm_source: 'facebook' } },
        { label: '+ fbclid=abc123', params: { fbclid: 'abc123' } },
      ];
      const rows = [];
      for (const v of variants) {
        const r = await callPlay('cdn/cache-key', v.params);
        rows.push({ label: v.label, cache: r.cache, ms: r.ms });
        this.render(el, rows);
      }
      return rows;
    },
  },

  /* Watch one cached object age through fresh -> stale -> refreshed. The STALE
     response is the interesting one: instant, while a refresh runs behind it. */
  timeline: {
    recorded: () => ([
      { t: 0, cache: 'MISS', ms: 431, age: 0 },
      { t: 2, cache: 'HIT', ms: 52, age: 2 },
      { t: 4, cache: 'HIT', ms: 47, age: 4 },
      { t: 7, cache: 'STALE', ms: 55, age: 7 },
      { t: 9, cache: 'HIT', ms: 49, age: 1 },
    ]),
    render(el, rows) {
      el.querySelector('.lab-body').innerHTML =
        `<div class="rows">${rows.map((r) => `
          <div class="r">
            <span class="idx">${r.t}s</span>
            <span><span class="chip ${chipClass(r.cache)}">${r.cache}</span></span>
            <span style="font-size:.78rem;color:var(--ink-2)">age ${r.age ?? '—'}s</span>
            <span class="ms">${r.ms}ms</span>
          </div>`).join('')}</div>` +
        (rows.some((r) => r.cache === 'STALE')
          ? banner('The <strong>STALE</strong> row is the point: served instantly from the old copy while a refresh ran in the background. Nobody waited.', 'info')
          : '');
    },
    async live(el) {
      const rows = [];
      const start = Date.now();
      for (const wait of [0, 2, 2, 3, 2]) {
        if (wait) await new Promise((r) => setTimeout(r, wait * 1000));
        const r = await callPlay('cdn/ttl-timeline', { maxage: 5 });
        rows.push({
          t: Math.round((Date.now() - start) / 1000),
          cache: r.cache, ms: r.ms, age: r.age,
        });
        this.render(el, rows);
      }
      return rows;
    },
  },

  /* Fire many at once at a cold, slow object. The lesson is that the edge
     collapses them: the origin sees far fewer requests than were sent. */
  stampede: {
    recorded: () => ({ sent: 10, statuses: Array(10).fill('MISS'), originHits: 2, wallMs: 1240 }),
    render(el, d) {
      el.querySelector('.lab-body').innerHTML =
        `<div class="rows">${d.statuses.map((s, i) => `
          <div class="r">
            <span class="idx">${i + 1}</span>
            <span><span class="chip ${chipClass(s)}">${s}</span></span>
            <span class="bar ${chipClass(s)}" style="width:100%"></span>
            <span class="ms"></span>
          </div>`).join('')}</div>` +
        readout([
          { label: 'requests sent', value: d.sent },
          { label: 'reached the origin', value: d.originHits ?? '—', tone: 'good' },
          { label: 'total time', value: `${d.wallMs}ms` },
        ]);
    },
    async live(el) {
      const n = Number(el.dataset.runs || 10);
      const t0 = performance.now();
      const results = await Promise.all(
        Array.from({ length: n }, () => callPlay('cdn/stampede', { ms: 600 }))
      );
      const wallMs = Math.round(performance.now() - t0);
      // X-Origin-Hit is the origin's own counter. Distinct values = distinct
      // origin fetches; a repeated value means the edge served copies of one.
      const distinct = new Set(results.map((r) => r.originHit).filter(Boolean));
      const d = {
        sent: n,
        statuses: results.map((r) => r.cache),
        originHits: distinct.size || '—',
        wallMs,
      };
      this.render(el, d);
      return d;
    },
  },
};

/* -------------------------------------------------------------------- mount */

function mount(el) {
  const type = el.dataset.widget;
  const w = WIDGETS[type];
  if (!w) return;

  const title = el.dataset.title || 'Live experiment';
  el.innerHTML = `
    <div class="lab-head">
      <h4>${title}</h4>
      <span class="mode">recorded</span>
      <button class="run" type="button">Run it live</button>
    </div>
    <div class="lab-body"></div>
    <div class="lab-note">${el.dataset.note || ''}</div>`;

  const body = el.querySelector('.lab-body');
  const btn = el.querySelector('.run');
  const mode = el.querySelector('.mode');

  const showRecorded = () => {
    w.render(el, w.recorded(el), false);
    mode.textContent = 'recorded';
    mode.classList.remove('live');
  };
  showRecorded();

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Running…';
    mode.textContent = 'live';
    mode.classList.add('live');
    body.innerHTML = '';
    try {
      await w.live(el);
      el.querySelector('.lab-note').innerHTML =
        `${el.dataset.note || ''} <em>Real requests, just now, from your browser.</em>`;
    } catch (err) {
      // Degrade to recorded rather than showing a broken widget. A reader
      // should never hit a dead end on a page whose job is explaining.
      showRecorded();
      body.insertAdjacentHTML('afterbegin', banner(
        err instanceof Halt ? err.message : 'Something went wrong running that live.',
        err.kind === 'ratelimited' ? '' : 'info'
      ));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run it live';
    }
  });
}

document.querySelectorAll('.lab[data-widget]').forEach(mount);
