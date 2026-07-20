/** @param {number[]} rgba */
export function rgbaToOklch(rgba) {
  const [red, green, blue, alpha = 1] = rgba;
  const [linearRed, linearGreen, linearBlue] = [red, green, blue].map((channel) => srgbToLinear(channel / 255));
  const l = 0.4122214708 * linearRed + 0.5363325363 * linearGreen + 0.0514459929 * linearBlue;
  const m = 0.2119034982 * linearRed + 0.6806995451 * linearGreen + 0.1073969566 * linearBlue;
  const s = 0.0883024619 * linearRed + 0.2817188376 * linearGreen + 0.6299787005 * linearBlue;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  const okL = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot;
  const okA = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
  const okB = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;
  const chroma = Math.sqrt(okA ** 2 + okB ** 2);
  const hue = chroma === 0 ? 0 : positiveHue((Math.atan2(okB, okA) * 180) / Math.PI);
  return { alpha, chroma, hue, lightness: okL };
}

/** @param {{alpha?: number, chroma: number, hue: number, lightness: number}} oklch */
export function oklchToRgba(oklch) {
  const okA = oklch.chroma * Math.cos((oklch.hue * Math.PI) / 180);
  const okB = oklch.chroma * Math.sin((oklch.hue * Math.PI) / 180);
  const lRoot = oklch.lightness + 0.3963377774 * okA + 0.2158037573 * okB;
  const mRoot = oklch.lightness - 0.1055613458 * okA - 0.0638541728 * okB;
  const sRoot = oklch.lightness - 0.0894841775 * okA - 1.291485548 * okB;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  const red = linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return [clampByte(red * 255), clampByte(green * 255), clampByte(blue * 255), oklch.alpha ?? 1];
}

/** @param {number[]} first @param {number[]} second */
export function contrastRatio(first, second) {
  const firstLum = relativeLuminance(blendWithBackground(first));
  const secondLum = relativeLuminance(blendWithBackground(second));
  const lighter = Math.max(firstLum, secondLum);
  const darker = Math.min(firstLum, secondLum);
  return (lighter + 0.05) / (darker + 0.05);
}

/** @param {number[]} foreground @param {number[]} background */
export function compositeOver(foreground, background) {
  const alpha = foreground[3] ?? 1;
  return [
    foreground[0] * alpha + background[0] * (1 - alpha),
    foreground[1] * alpha + background[1] * (1 - alpha),
    foreground[2] * alpha + background[2] * (1 - alpha),
    1,
  ];
}

/** @param {string} value @returns {number[]} */
export function parseColor(value) {
  const color = value.trim().toLowerCase();
  if (color === 'white') return [255, 255, 255, 1];
  if (color === 'black') return [0, 0, 0, 1];
  const hex = /^#([0-9a-f]{6})$/.exec(color);
  if (hex) {
    const intValue = Number.parseInt(hex[1], 16);
    return [(intValue >> 16) & 255, (intValue >> 8) & 255, intValue & 255, 1];
  }
  const rgb = /^rgba?\((\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*(\d+(?:\.\d+)?)%)?\)$/.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) / 100 : 1];
  throw new Error(`Unsupported color: ${value}`);
}

/** @param {number[]} rgba */
function relativeLuminance(rgba) {
  const [red, green, blue] = rgba.slice(0, 3).map((channel) => srgbToLinear(channel / 255));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** @param {number[]} rgba */
function blendWithBackground(rgba) {
  const alpha = rgba[3] ?? 1;
  return rgba.slice(0, 3).map((channel) => channel * alpha + 255 * (1 - alpha));
}

/** @param {number} value */
function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** @param {number} value */
function linearToSrgb(value) {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** @param {number} value */
function clampByte(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** @param {number} value */
function positiveHue(value) {
  return value < 0 ? value + 360 : value;
}
