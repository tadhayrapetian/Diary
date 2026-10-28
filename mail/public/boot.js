// Runs before first paint so the page never flashes the wrong theme.
(() => {
  let s = {};
  try {
    s = JSON.parse(localStorage.getItem('aether.settings') || '{}');
  } catch {}
  const root = document.documentElement;
  const theme = s.theme || 'auto';
  const skin = s.skin || 'aether';
  const dark = skin === 'aether' && (theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches));
  root.dataset.scheme = dark ? 'dark' : 'light';
  root.dataset.skin = skin;
  root.dataset.density = s.density || 'comfortable';
  if (s.accent) root.style.setProperty('--accent-h', s.accent);
})();
