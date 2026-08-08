/* "On this page" — built from the document at runtime.
 *
 * Generated rather than hand-authored so that adding a heading never requires a
 * second, separate edit. Hand-maintained navigation is exactly how post 3 ended
 * up as a dead end: the content changed and the links did not.
 *
 * Degrades to nothing. If this script fails to load the rail stays empty and
 * the article is unaffected — the sidebar and in-page prev/next carry
 * navigation on their own.
 */

const rail = document.querySelector('.toc');
const headings = [...document.querySelectorAll('main h2')];
if (rail && headings.length > 1) {
  const slug = (t) => t.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 50);

  rail.innerHTML = '<p>On this page</p>';
  const links = headings.map((h) => {
    if (!h.id) h.id = slug(h.textContent);
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.textContent = h.textContent;
    rail.append(a);
    return a;
  });

  // Highlight whichever heading is nearest the top of the viewport. The upper
  // band keeps the marker on the section being READ rather than one scrolling
  // into view at the bottom of the screen.
  const seen = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) seen.add(e.target.id); else seen.delete(e.target.id);
    }
    const first = headings.find((h) => seen.has(h.id));
    const active = first || [...headings].reverse()
      .find((h) => h.getBoundingClientRect().top < 120);
    links.forEach((a) => a.classList.toggle('here', active && a.hash === `#${active.id}`));
  }, { rootMargin: '0px 0px -70% 0px' });

  headings.forEach((h) => io.observe(h));
}

/* Sidebar filter.
 *
 * Lives here rather than in its own file because every page already loads this
 * one — a separate script would be an extra request for eight lines, and it
 * shipped once already with nothing loading it at all.
 *
 * build-nav.js only emits the input past six labs, so below that this finds
 * nothing and does nothing. Filtering works on text already in the page: no
 * index, no fetch. Groups are hidden rather than removed, so clearing the box
 * restores everything.
 */
const navFilter = document.querySelector('.navfilter');
if (navFilter) {
  const groups = [...document.querySelectorAll('.sidebar .navgroup')];
  navFilter.addEventListener('input', () => {
    const q = navFilter.value.trim().toLowerCase();
    for (const g of groups) g.hidden = q !== '' && !g.textContent.toLowerCase().includes(q);
  });
}
