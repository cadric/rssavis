(function () {
  const key = 'rssavis.theme.v1';
  const schemes = new Set(['system', 'light', 'dark']);
  const accents = new Set(['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'slate']);
  const root = document.documentElement;
  /** @type {{colorScheme?: string, accentColor?: string}} */
  let value = {};
  try {
    value = JSON.parse(localStorage.getItem(key) || '{}') || {};
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    value = {};
  }
  const rawScheme = typeof value.colorScheme === 'string' ? value.colorScheme : '';
  const rawAccent = typeof value.accentColor === 'string' ? value.accentColor : '';
  const scheme = schemes.has(rawScheme) ? rawScheme : 'system';
  const accent = accents.has(rawAccent) ? rawAccent : 'blue';
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  const effective = scheme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : scheme;
  root.dataset.colorScheme = scheme;
  root.dataset.effectiveScheme = effective;
  root.dataset.accentColor = accent;
  root.style.colorScheme = effective;
})();
