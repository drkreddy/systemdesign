/* Navigation audit.
 *
 * Post 3 shipped as a dead end: written before 4 and 5 existed, and never
 * revisited when they landed. Nothing caught it — every link on the page
 * resolved, so a link crawler passed. The bug was a link that was ABSENT.
 *
 * Scoped to the in-content .postnav block ON PURPOSE. The sidebar lists every
 * post on every page, so checking the whole document would pass trivially
 * whether or not sequential navigation existed — the same vacuous-pass problem
 * this file was written to catch, reintroduced by a layout change.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../public/', import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  ok ? pass++ : fail++;
};

for (const lab of ['cdn', 'rate-limit']) {
  const posts = readdirSync(join(ROOT, lab)).filter((f) => /^\d+\.html$/.test(f)).sort();
  console.log(`\n— ${lab}: ${posts.length} posts —`);
  posts.forEach((file, i) => {
    const full = readFileSync(join(ROOT, lab, file), 'utf8');
    const m = full.match(/<div class="postnav">([\s\S]*?)<\/div>/);
    if (!m) { check(`${file} has a postnav block`, false); return; }
    const html = m[1];
    const n = file.replace('.html', '');
    const next = posts[i + 1]?.replace('.html', '');
    const prev = posts[i - 1]?.replace('.html', '');
    if (next) check(`${n} links forward to ${next}`, html.includes(`href="/${lab}/${next}"`));
    if (prev) check(`${n} links back to ${prev}`,     html.includes(`href="/${lab}/${prev}"`));
    // The sidebar always links home, so only the first and last post of a lab
    // need an index link in their sequential navigation.
    if (!next || !prev) check(`${n} offers a way back to the index`, html.includes('href="/"'));
  });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
