/* Regenerates every sidebar, and the index's lab sections, from labs.json.
 *
 * The nav used to be copied into each page, so adding a post meant rewriting
 * every file — done by ad-hoc script twice, which is how a stale nav becomes
 * possible. One manifest now owns it.
 *
 * Two properties matter and both are tested:
 *
 *   IDEMPOTENT — it replaces the region between markers rather than appending,
 *   so running it twice changes nothing. That is what makes it safe to run in
 *   CI and to fail the build on a diff.
 *
 *   LINEAR IN LABS, NOT POSTS — only the current lab is expanded; every other
 *   lab ships as one row. Twenty labs of five posts is ~25 rows, not 100, and
 *   the markup stops growing as individual labs get longer.
 *
 * Run: node blog/scripts/build-nav.js  (or npm run build)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOG = join(HERE, '..');
const PUBLIC = join(BLOG, 'public');

// A single well-formed comment. The first version closed after 'nav:start',
// leaving the rest as visible text — which also became a grid item and shoved
// every column one place to the right.
const NAV_START = '<!-- nav:start | generated from labs.json, do not edit by hand -->';
const NAV_END = '<!-- nav:end -->';
const IDX_START = '<!-- labs:start | generated from labs.json, do not edit by hand -->';
const IDX_END = '<!-- labs:end -->';

const manifest = JSON.parse(readFileSync(join(BLOG, 'labs.json'), 'utf8'));
const labs = manifest.labs;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The sidebar for one page. `current` is "lab/nn", or null on the index. */
function sidebar(current) {
  const currentLab = current ? current.split('/')[0] : null;
  const out = [
    NAV_START,
    '<nav class="sidebar">',
    '  <a class="brand" href="/">drkreddy <span>/ labs</span></a>',
  ];

  // A filter only earns its place once the list is long enough to search.
  if (labs.length > 6) {
    out.push('  <input class="navfilter" type="search" placeholder="Filter labs…" aria-label="Filter labs">');
  }

  for (const lab of labs) {
    if (lab.slug === currentLab) {
      out.push('  <div class="navgroup">');
      out.push(`    <p class="navlabel">${esc(lab.title)}</p>`);
      for (const p of lab.posts) {
        const cur = current === `${lab.slug}/${p.n}` ? ' aria-current="page"' : '';
        out.push(`    <a class="post" href="/${lab.slug}/${p.n}"${cur}>` +
                 `<span class="n">${p.n}</span><span>${esc(p.nav)}</span></a>`);
      }
      out.push('  </div>');
    } else {
      // Collapsed: one row carrying the post count, linking to the lab's first
      // post. Cheap in bytes and it keeps every lab reachable in one click.
      out.push('  <div class="navgroup">');
      out.push(`    <a class="lab" href="/${lab.slug}/${lab.posts[0].n}">` +
               `<span>${esc(lab.title)}</span><span class="count">${lab.posts.length}</span></a>`);
      out.push('  </div>');
    }
  }

  out.push('</nav>', NAV_END);
  return out.join('\n');
}

/** The index's per-lab sections. */
function indexSections() {
  const out = [IDX_START];
  for (const lab of labs) {
    out.push(`<h2>${esc(lab.title)} <span style="font-weight:400;color:var(--ink-3);font-size:.7em">` +
             `${lab.posts.length} posts</span></h2>`);
    out.push(`<p>${lab.blurb}</p>`);
    if (lab.note) out.push(`<p>${lab.note}</p>`);
    out.push('<div class="cards">');
    for (const p of lab.posts) {
      out.push(`  <a class="card" href="/${lab.slug}/${p.n}">`);
      out.push(`    <span class="n">${p.n}</span>`);
      out.push(`    <h3>${esc(p.title)}</h3>`);
      out.push(`    <p>${esc(p.blurb)}</p>`);
      out.push('  </a>');
    }
    out.push('</div>');
  }
  out.push(IDX_END);
  return out.join('\n');
}

/** Replaces a marked region, or the legacy hand-written block on first run. */
function replaceRegion(html, start, end, replacement, legacy) {
  const s = html.indexOf(start);
  if (s !== -1) {
    const e = html.indexOf(end, s);
    if (e === -1) throw new Error('found a start marker with no matching end marker');
    return html.slice(0, s) + replacement + html.slice(e + end.length);
  }
  const m = html.match(legacy);
  if (!m) return null;
  return html.slice(0, m.index) + replacement + html.slice(m.index + m[0].length);
}

let written = 0, skipped = 0;
for (const lab of labs) {
  for (const p of lab.posts) {
    const file = join(PUBLIC, lab.slug, `${p.n}.html`);
    if (!existsSync(file)) { console.error(`  MISSING ${lab.slug}/${p.n}.html`); process.exitCode = 1; continue; }
    const html = readFileSync(file, 'utf8');
    const next = replaceRegion(html, NAV_START, NAV_END, sidebar(`${lab.slug}/${p.n}`),
                               /<nav class="sidebar">[\s\S]*?<\/nav>/);
    if (next === null) { console.error(`  NO NAV BLOCK in ${file}`); process.exitCode = 1; continue; }
    if (next !== html) { writeFileSync(file, next); written++; } else skipped++;
  }
}

// Pages that are not posts still carry the sidebar, with nothing marked current.
for (const name of ['index.html', '404.html']) {
  const file = join(PUBLIC, name);
  if (!existsSync(file)) continue;
  let html = readFileSync(file, 'utf8');
  const orig = html;
  const withNav = replaceRegion(html, NAV_START, NAV_END, sidebar(null),
                                /<nav class="sidebar">[\s\S]*?<\/nav>/);
  if (withNav === null) { console.error(`  NO NAV BLOCK in ${file}`); process.exitCode = 1; continue; }
  html = withNav;

  if (name === 'index.html') {
    const withIdx = replaceRegion(html, IDX_START, IDX_END, indexSections(),
                                  /<h2>CDN[\s\S]*?<\/div>\s*(?=<h2>How the live experiments work<\/h2>)/);
    if (withIdx === null) console.error('  NO LAB SECTION MARKERS in index.html — left as-is');
    else html = withIdx;
  }
  if (html !== orig) { writeFileSync(file, html); written++; } else skipped++;
}

console.log(`  build-nav: ${written} rewritten, ${skipped} already current`);
