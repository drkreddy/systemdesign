/* Navigation audit.
 *
 * Three things have gone wrong here before, and each has an assertion:
 *
 *  1. Post 3 shipped as a dead end — written before 4 and 5 existed and never
 *     revisited. A link crawler passed, because every link PRESENT resolved;
 *     the defect was a link that was absent.
 *  2. Adding the sidebar made this file vacuous: every page then contained
 *     every link, so a whole-document check passed regardless. The sequential
 *     checks are scoped to the in-content .postnav block for that reason.
 *  3. The nav is now generated from labs.json, so the manifest and the
 *     filesystem can drift apart. Checked in BOTH directions.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BLOG = new URL('../', import.meta.url).pathname;
const PUBLIC = join(BLOG, 'public');
const manifest = JSON.parse(readFileSync(join(BLOG, 'labs.json'), 'utf8'));

let pass = 0, fail = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  ok ? pass++ : fail++;
};

for (const lab of manifest.labs) {
  console.log(`\n— ${lab.slug}: ${lab.posts.length} posts —`);

  // manifest -> filesystem
  for (const p of lab.posts) {
    check(`${p.n} exists on disk`, existsSync(join(PUBLIC, lab.slug, `${p.n}.html`)));
  }
  // filesystem -> manifest, so a post cannot exist unregistered and therefore
  // unreachable from any sidebar
  const onDisk = readdirSync(join(PUBLIC, lab.slug)).filter((f) => /^\d+\.html$/.test(f));
  const listed = new Set(lab.posts.map((p) => `${p.n}.html`));
  for (const f of onDisk) check(`${f} is registered in labs.json`, listed.has(f));

  lab.posts.forEach((p, i) => {
    const full = readFileSync(join(PUBLIC, lab.slug, `${p.n}.html`), 'utf8');

    // The sidebar lists every post, so sequential checks must look only at the
    // in-content navigation or they pass trivially.
    const m = full.match(/<div class="postnav">([\s\S]*?)<\/div>/);
    if (!m) { check(`${p.n} has a postnav block`, false); return; }
    const nav = m[1];

    const next = lab.posts[i + 1]?.n;
    const prev = lab.posts[i - 1]?.n;
    if (next) check(`${p.n} links forward to ${next}`, nav.includes(`href="/${lab.slug}/${next}"`));
    if (prev) check(`${p.n} links back to ${prev}`, nav.includes(`href="/${lab.slug}/${prev}"`));
    if (!next || !prev) check(`${p.n} offers a way back to the index`, nav.includes('href="/"'));

    // Generated sidebar must actually be present and marked.
    check(`${p.n} sidebar marks itself current`,
          full.includes(`href="/${lab.slug}/${p.n}" aria-current="page"`));
    // Every other lab must be reachable in one click from every page.
    for (const other of manifest.labs.filter((l) => l.slug !== lab.slug)) {
      check(`${p.n} can reach ${other.slug}`,
            full.includes(`class="lab" href="/${other.slug}/${other.posts[0].n}"`));
    }
  });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
