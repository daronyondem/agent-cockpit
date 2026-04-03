// ─── Theme ───────────────────────────────────────────────────────────────────
export function applyTheme(theme) {
  let resolved = theme;
  if (theme === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', resolved);
  const hljsLink = document.getElementById('hljs-theme');
  if (hljsLink) {
    const hljsStyle = resolved === 'dark' ? 'github-dark' : 'github';
    hljsLink.href = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/${hljsStyle}.min.css`;
  }
  try { localStorage.setItem('agent-cockpit-theme', theme); } catch (e) {}
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const cached = localStorage.getItem('agent-cockpit-theme') || 'system';
  if (cached === 'system') applyTheme('system');
});

applyTheme(localStorage.getItem('agent-cockpit-theme') || 'system');
