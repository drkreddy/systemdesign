/* Filters the sidebar. build-nav.js only emits the input once there are more
 * than six labs, so on a small site this script finds nothing and does nothing.
 *
 * Filtering happens on text already in the page — no index, no fetch. It hides
 * groups rather than removing them, so clearing the box restores everything
 * without a rebuild.
 */
const input = document.querySelector('.navfilter');
if (input) {
  const groups = [...document.querySelectorAll('.sidebar .navgroup')];
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    for (const g of groups) {
      g.hidden = q !== '' && !g.textContent.toLowerCase().includes(q);
    }
  });
}
