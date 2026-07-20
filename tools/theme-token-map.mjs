const LAYER_ORDER = '@layer reset, tokens, base, layout, components, utilities, overrides;';

/**
 * @param {{stateOpacity: {dimHighContrast: number, dimRegular: number, disabledHighContrast: number, disabledRegular: number}, componentValues: {menuPx: {rowHeight: number, inlinePadding: number, rowRadius: number, outerPadding: number, popoverRadius: number}, toast: {radiusPx: number, outerSpacingPx: number, blockPaddingPx: number, inlineStartPaddingPx: number, shadow: string}, banner: {horizontalSpacingPx: number, centeredSpacingPx: number, verticalSpacingPx: number, paddingPx: number, actionMinimumPx: number[]}}}} source
 */
export function tokensCss(source) {
  const { banner, menuPx, toast } = source.componentValues;
  const { stateOpacity } = source;
  return `${LAYER_ORDER}
@layer tokens {
  :root {
    color-scheme: light dark;
    --rs-font-sans: 'Adwaita Sans', Cantarell, system-ui, sans-serif;
    --rs-font-size-caption: 0.75rem;
    --rs-line-height-caption: 1.35;
    --rs-font-size-small: 0.8125rem;
    --rs-line-height-small: 1.35;
    --rs-font-size-body: 0.9375rem;
    --rs-line-height-body: 1.4;
    --rs-font-size-heading: 0.9375rem;
    --rs-line-height-heading: 1.25;
    --rs-font-size-title: 1.25rem;
    --rs-line-height-title: 1.2;
    --rs-font-size-document: 1rem;
    --rs-line-height-document: 1.6;
    --rs-opacity-disabled: ${stateOpacity.disabledRegular};
    --rs-opacity-disabled-high-contrast: ${stateOpacity.disabledHighContrast};
    --rs-opacity-dim: ${stateOpacity.dimRegular};
    --rs-opacity-dim-high-contrast: ${stateOpacity.dimHighContrast};
    --rs-radius-window: 0.75rem;
    --rs-radius-control: 0.5rem;
    --rs-radius-card: 0.5rem;
    --rs-radius-dialog: 0.75rem;
    --rs-sidebar-width: 278px;
    --rs-content-width: 920px;
    --rs-headerbar-height: 3rem;
    --rs-menu-row-min-block-size: ${menuPx.rowHeight}px;
    --rs-menu-row-radius: ${menuPx.rowRadius}px;
    --rs-menu-row-padding-inline: ${menuPx.inlinePadding}px;
    --rs-menu-outer-padding: ${menuPx.outerPadding}px;
    --rs-popover-radius: ${menuPx.popoverRadius}px;
    --rs-toast-radius: ${toast.radiusPx}px;
    --rs-toast-outer-spacing: ${toast.outerSpacingPx}px;
    --rs-toast-block-padding: ${toast.blockPaddingPx}px;
    --rs-toast-inline-start-padding: ${toast.inlineStartPaddingPx}px;
    --rs-toast-shadow: ${toast.shadow};
    --rs-banner-horizontal-spacing: ${banner.horizontalSpacingPx}px;
    --rs-banner-centered-spacing: ${banner.centeredSpacingPx}px;
    --rs-banner-vertical-spacing: ${banner.verticalSpacingPx}px;
    --rs-banner-padding: ${banner.paddingPx}px;
    --rs-banner-action-min-inline-size: ${banner.actionMinimumPx[0]}px;
    --rs-banner-action-stacked-min-inline-size: ${banner.actionMinimumPx[1]}px;
    --rs-transition-fast: 140ms ease;
    --rs-transition-medium: 240ms ease;
  }
}
`;
}
