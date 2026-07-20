# RSSavis brand sources

The committed icon raster set has one explicit source map:

- `app-icon-16.svg` renders only `icons/app-16.png`.
- `app-icon.svg` renders `icons/app-{32,48,64,96,128}.png`.

The generated PNG files are committed so cloning, testing, and packaging do not require local icon tooling. When either SVG changes, regenerate its owned PNG files with `npm run generate:icons` and review the resulting packaged assets.

Icon regeneration requires local librsvg bindings through Python GI, plus Cairo. The generator reports the installed renderer versions and can compare fresh renders with the committed files by running `node tools/render-brand-icons.mjs --check`.
