// @ts-check

export const SHORTCUT_ROWS = Object.freeze([
  { id: 'search', key: 'primary+F', messageKey: 'shortcutSearch' },
  { id: 'mark-read', key: 'Shift+A', messageKey: 'shortcutMarkRead' },
  { id: 'settings', key: 'primary+,', messageKey: 'shortcutSettings' },
  { id: 'menu', key: 'F10', messageKey: 'shortcutMenu' },
  { id: 'shortcuts', key: '?', messageKey: 'shortcutShortcuts' },
  { id: 'help', key: 'F1', messageKey: 'shortcutHelp' },
]);

/**
 * @param {string} key
 * @param {Window} windowRef
 */
export function shortcutLabel(key, windowRef) {
  const primary = /Mac|iPhone|iPad/u.test(windowRef.navigator.platform || windowRef.navigator.userAgent)
    ? 'Meta'
    : 'Ctrl';
  return key.replace('primary', primary);
}
