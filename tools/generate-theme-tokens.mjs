import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compositeOver, contrastRatio, oklchToRgba, parseColor, rgbaToOklch } from './theme-color.mjs';
import { tokensCss } from './theme-token-map.mjs';

export { compositeOver, contrastRatio, oklchToRgba, parseColor, rgbaToOklch } from './theme-color.mjs';

const SOURCE_PATH = 'tools/theme-sources/libadwaita-1.9.2.json';
const THEME_DIR = 'styles/themes';
const DARK_TEXT = [0, 0, 0, 1];
const LIGHT_TEXT = [255, 255, 255, 1];
const LAYER_ORDER = '@layer reset, tokens, base, layout, components, utilities, overrides;';
const GENERATED_AA_CONTRAST = 4.55;
const ACCENT_SURFACE_CONTRAST = 3;

/**
 * @param {string} root
 */
export async function generateThemeFiles(root = '.') {
  const source = JSON.parse(await readFile(join(root, SOURCE_PATH), 'utf8'));
  const outputDir = join(root, THEME_DIR);
  const swatches = { dark: source.sourceValues.dark.windowBg, light: source.sourceValues.light.windowBg };
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'tokens.css'), tokensCss(source), 'utf8');
  await writeFile(
    join(outputDir, 'adwaita-light.css'),
    schemeCss('light', source.sourceValues.light, source.sourceValues.destructive, swatches, source.componentValues),
    'utf8',
  );
  await writeFile(
    join(outputDir, 'adwaita-dark.css'),
    schemeCss('dark', source.sourceValues.dark, source.sourceValues.destructive, swatches, source.componentValues),
    'utf8',
  );
  await writeFile(join(outputDir, 'accents.css'), accentCss(source.sourceValues.accents, source.sourceValues), 'utf8');
}

/**
 * @param {string} mode
 * @param {Record<string, string>} values
 * @param {{lightBg: string, darkBg: string, fg: string}} destructive
 * @param {{dark: string, light: string}} swatches
 * @param {{selectedAlpha: number[], raisedButtonAlpha: number[], flatButtonAlpha: number[], toast: {background: string, foreground: string}, banner: {background: string, mixAlpha: number, backdropAlpha: number}}} components
 */
function schemeCss(mode, values, destructive, swatches, components) {
  const viewBackground = parseColor(values.viewBg);
  const cardBackground = compositeOver(parseColor(values.cardBg), viewBackground);
  const popoverBackground = compositeOver(parseColor(values.popoverBg), viewBackground);
  const destructiveBackground = parseColor(mode === 'dark' ? destructive.darkBg : destructive.lightBg);
  const destructiveTextSeed = parseColor(mode === 'dark' ? destructive.darkBg : '#c30000');
  const destructiveText = textColorForContrast(
    destructiveTextSeed,
    [viewBackground, cardBackground, popoverBackground],
    mode,
  );
  const textLevels = derivedTextLevels(values.viewFg, values.viewBg);
  const sidebarTextLevels = derivedTextLevels(values.sidebarFg, values.sidebarBg);
  const foreground = parseColor(values.viewFg);
  const windowBackground = parseColor(values.windowBg);
  const selected = components.selectedAlpha.map((alpha) => withAlpha(foreground, alpha));
  const raised = components.raisedButtonAlpha.map((alpha) => withAlpha(foreground, alpha));
  const flat = components.flatButtonAlpha.map((alpha) => withAlpha(foreground, alpha));
  const toastForeground = parseColor(components.toast.foreground);
  const toastRaised = components.raisedButtonAlpha.map((alpha) => withAlpha(toastForeground, alpha));
  const toastFlat = components.flatButtonAlpha.map((alpha) => withAlpha(toastForeground, alpha));
  const bannerSeed = parseColor(components.banner.background);
  const bannerBackground = compositeOver(withAlpha(bannerSeed, components.banner.mixAlpha), windowBackground);
  const bannerBackdrop = compositeOver(withAlpha(bannerSeed, components.banner.backdropAlpha), windowBackground);
  const tokenMap = {
    '--rs-color-window-bg': values.windowBg,
    '--rs-color-view-bg': values.viewBg,
    '--rs-color-headerbar-bg': values.headerbarBg,
    '--rs-color-sidebar-bg': values.sidebarBg,
    '--rs-color-card-bg': values.cardBg,
    '--rs-color-dialog-bg': values.dialogBg,
    '--rs-color-dialog-fg': values.dialogFg,
    '--rs-color-popover-bg': values.popoverBg,
    '--rs-color-raised-bg': values.cardBg,
    '--rs-color-border': values.sidebarBorder,
    '--rs-color-separator': values.shade,
    '--rs-color-card-shade': values.cardShade,
    '--rs-color-popover-shade': values.popoverShade,
    '--rs-color-sidebar-border': values.sidebarBorder,
    '--rs-color-headerbar-shade': scaledAlpha(values.shade, mode === 'dark' ? 1.44 : 1.72),
    '--rs-color-swatch-border': values.sidebarBorder,
    '--rs-color-scheme-swatch-light': swatches.light,
    '--rs-color-scheme-swatch-dark': swatches.dark,
    '--rs-color-text': values.viewFg,
    '--rs-color-text-muted': mode === 'dark' ? 'RGB(255 255 255 / 70%)' : 'RGB(0 0 6 / 60%)',
    '--rs-color-ink': textLevels.ink,
    '--rs-color-secondary': textLevels.secondary,
    '--rs-color-dim': textLevels.dim,
    '--rs-color-faint': textLevels.faint,
    '--rs-color-feedname': sidebarTextLevels.ink,
    '--rs-color-sidebar-muted': sidebarTextLevels.dim,
    '--rs-color-hover-bg': mode === 'dark' ? 'RGB(255 255 255 / 8%)' : 'RGB(0 0 6 / 6%)',
    '--rs-color-selected-bg': mode === 'dark' ? 'RGB(53 132 228 / 28%)' : 'RGB(53 132 228 / 18%)',
    '--rs-color-active-bg': selected[0],
    '--rs-color-navigation-selected-bg': selected[0],
    '--rs-color-navigation-selected-hover-bg': selected[1],
    '--rs-color-navigation-selected-active-bg': selected[2],
    '--rs-color-navigation-selected-fg': values.sidebarFg,
    '--rs-color-pill': scaledAlpha(values.shade, 1.35),
    '--rs-color-btn-soft': scaledAlpha(values.shade, 1.6),
    '--rs-color-menu-hover': selected[0],
    '--rs-color-toggle-active-bg': values.activeToggleBg,
    '--rs-color-toggle-active-fg': values.activeToggleFg,
    '--rs-color-button-bg': mode === 'dark' ? 'RGB(255 255 255 / 10%)' : 'RGB(255 255 255 / 72%)',
    '--rs-color-button-hover-bg': mode === 'dark' ? 'RGB(255 255 255 / 15%)' : 'RGB(255 255 255 / 92%)',
    '--rs-color-raised-normal-bg': raised[0],
    '--rs-color-raised-hover-bg': raised[1],
    '--rs-color-raised-active-bg': raised[2],
    '--rs-color-flat-hover-bg': flat[1],
    '--rs-color-flat-active-bg': flat[2],
    '--rs-color-toast-bg': components.toast.background,
    '--rs-color-toast-fg': components.toast.foreground,
    '--rs-color-toast-action-bg': toastRaised[0],
    '--rs-color-toast-action-hover-bg': toastRaised[1],
    '--rs-color-toast-action-active-bg': toastRaised[2],
    '--rs-color-toast-flat-hover-bg': toastFlat[1],
    '--rs-color-toast-flat-active-bg': toastFlat[2],
    '--rs-color-banner-bg': bannerBackground,
    '--rs-color-banner-backdrop-bg': bannerBackdrop,
    '--rs-color-banner-fg': values.windowFg,
    '--rs-color-banner-action-bg': raised[0],
    '--rs-color-banner-action-hover-bg': raised[1],
    '--rs-color-banner-action-active-bg': raised[2],
    '--rs-color-destructive-bg': destructiveBackground,
    '--rs-color-destructive-fg': destructive.fg,
    '--rs-color-destructive-text': destructiveText,
    '--rs-color-destructive-soft': withAlpha(destructiveBackground, mode === 'dark' ? 0.24 : 0.14),
    '--rs-color-star': '#f5c211',
    '--rs-color-focus-ring': mode === 'dark' ? 'RGB(153 193 241 / 88%)' : 'RGB(28 113 216 / 82%)',
    '--rs-color-scrim': mode === 'dark' ? 'RGB(0 0 6 / 62%)' : 'RGB(0 0 6 / 38%)',
    '--rs-color-scrollbar-thumb': mode === 'dark' ? 'RGB(255 255 255 / 36%)' : 'RGB(0 0 6 / 28%)',
    '--rs-color-scrollbar-track': mode === 'dark' ? 'RGB(0 0 6 / 20%)' : 'RGB(0 0 6 / 7%)',
  };
  return `${LAYER_ORDER}\n@layer tokens {\n  :root[data-effective-scheme='${mode}'] {\n${formatTokenMap(tokenMap)}\n  }\n}\n`;
}

/**
 * @param {Record<string, string>} accents
 * @param {{light: Record<string, string>, dark: Record<string, string>}} values
 */
function accentCss(accents, values) {
  const names = Object.keys(accents);
  const rootTokens = Object.fromEntries(
    names.flatMap((name, index) => {
      const background = parseColor(accents[name]);
      return [
        [`--rs-accent-swatch-${name}`, accents[name]],
        [`--rs-color-identity-${index}`, accents[name]],
        [`--rs-color-identity-fg-${index}`, accentSurfaceForeground(background)],
      ];
    }),
  );
  const rootBlock = `  :root {\n${formatTokenMap(rootTokens)}\n  }`;
  const accentBlocks = Object.entries(accents).map(([name, color]) => {
    const bg = parseColor(color);
    const fg = accentSurfaceForeground(bg);
    const selected = bg.slice();
    selected[3] = 0.22;
    return `  :root[data-accent-color='${name}'] {\n    --rs-color-accent-bg: ${formatOklch(rgbaToOklch(bg))};\n    --rs-color-accent-fg: ${formatOklch(rgbaToOklch(fg))};\n    --rs-color-selected-bg: ${formatOklch(rgbaToOklch(selected))};\n  }`;
  });
  const accentTextBlocks = Object.entries(accents).flatMap(([name, color]) => {
    const bg = parseColor(color);
    return /** @type {const} */ (['light', 'dark']).map((mode) => {
      const accentText = textColorForContrast(bg, [parseColor(values[mode].viewBg)], mode);
      return `  :root[data-effective-scheme='${mode}'][data-accent-color='${name}'] {\n    --rs-color-accent-text: ${formatOklch(rgbaToOklch(accentText))};\n  }`;
    });
  });
  return `${LAYER_ORDER}\n@layer tokens {\n${[rootBlock, ...accentBlocks, ...accentTextBlocks].join('\n\n')}\n}\n`;
}

/**
 * @param {Record<string, string | number[]>} tokenMap
 */
function formatTokenMap(tokenMap) {
  return Object.entries(tokenMap)
    .map(([key, value]) => `    ${key}: ${formatTokenValue(value)};`)
    .join('\n');
}

/**
 * @param {string | number[]} value
 */
function formatTokenValue(value) {
  if (Array.isArray(value)) return formatOklch(rgbaToOklch(value));
  return /^\d+(?:\.\d+)?$/.test(value) ? value : formatOklch(rgbaToOklch(parseColor(value)));
}

/**
 * @param {{alpha?: number, chroma: number, hue: number, lightness: number}} color
 */
function formatOklch(color) {
  const alpha = color.alpha ?? 1;
  const base = `oklch(${round(color.lightness * 100, 3)}% ${round(color.chroma, 5)} ${round(color.hue, 3)}`;
  return alpha === 1 ? `${base})` : `${base} / ${round(alpha * 100, 3)}%)`;
}

/**
 * @param {number[]} background
 */
export function bestForeground(background) {
  return contrastRatio(background, DARK_TEXT) >= contrastRatio(background, LIGHT_TEXT) ? DARK_TEXT : LIGHT_TEXT;
}

/**
 * @param {number[]} background
 */
export function accentSurfaceForeground(background) {
  return contrastRatio(background, LIGHT_TEXT) >= ACCENT_SURFACE_CONTRAST ? LIGHT_TEXT : DARK_TEXT;
}

/**
 * @param {number[]} seed
 * @param {number[][]} backgrounds
 * @param {string} mode
 */
function textColorForContrast(seed, backgrounds, mode) {
  const base = { ...rgbaToOklch(seed), alpha: 1 };
  const direction = mode === 'dark' ? 1 : -1;
  for (let step = 0; step <= 1000; step += 1) {
    const lightness = Math.min(1, Math.max(0, base.lightness + (direction * step) / 1000));
    const candidate = oklchToRgba({ ...base, lightness });
    if (backgrounds.every((background) => contrastRatio(candidate, background) >= GENERATED_AA_CONTRAST)) {
      return candidate;
    }
  }
  return mode === 'dark' ? LIGHT_TEXT : DARK_TEXT;
}

/**
 * @param {string} foregroundValue
 * @param {string} backgroundValue
 */
function derivedTextLevels(foregroundValue, backgroundValue) {
  const foreground = parseColor(foregroundValue);
  const background = parseColor(backgroundValue);
  const sourceAlpha = foreground[3] ?? 1;
  return {
    // B18 a11y release review (A11Y-001/A11Y-007): 0.66 measured 4.397:1 in the light scheme for
    // --rs-color-dim against --rs-color-view-bg, below the WCAG AA 4.5:1 floor for normal (not
    // bold/large) text such as .article-row time and menus.css kbd hints. 0.7 restores ~4.92:1 in
    // light and keeps dark comfortably higher. The pinned local source JSON and generator contract
    // keep this derived threshold reproducible; the public generation parity test verifies it.
    dim: compositeWithAlpha(foreground, background, sourceAlpha * 0.7),
    faint: compositeWithAlpha(foreground, background, sourceAlpha * 0.48),
    ink: compositeWithAlpha(foreground, background, sourceAlpha),
    secondary: compositeWithAlpha(foreground, background, sourceAlpha * 0.82),
  };
}

/**
 * @param {number[]} foreground
 * @param {number[]} background
 * @param {number} alpha
 */
function compositeWithAlpha(foreground, background, alpha) {
  return compositeOver(withAlpha(foreground, alpha), background);
}

/**
 * @param {string} value
 * @param {number} multiplier
 */
function scaledAlpha(value, multiplier) {
  const rgba = parseColor(value);
  return withAlpha(rgba, (rgba[3] ?? 1) * multiplier);
}

/**
 * @param {number[]} rgba
 * @param {number} alpha
 */
function withAlpha(rgba, alpha) {
  return [rgba[0], rgba[1], rgba[2], clampUnit(alpha)];
}

/**
 * @param {number} value
 */
function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * @param {number} value
 * @param {number} decimals
 */
function round(value, decimals) {
  return Number(value.toFixed(decimals));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateThemeFiles(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
