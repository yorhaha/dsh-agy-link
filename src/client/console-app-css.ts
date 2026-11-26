// Application-style console chrome for the sidebar page.
//
// This is a deliberate second design pass. The first pass merely re-skinned the
// host settings widgets (grey "section cards" under a pill tab bar). This sheet
// builds the console as a *self-contained application surface* in the manner of
// the reference plugin (../dsh-plugins/file-memory): its own `agy2-*` class
// namespace, a real app header, a dense icon+label+count tab strip, and card
// primitives with a header row and a body — all painted from the existing
// `--agy-*` token layer (which itself maps onto `--dsw-alias-*`), so every
// colour degrades gracefully in light and dark mode.
//
// Layout reflows off `.agy2-root[data-narrow="true"]`, a measured-width flag set
// by the page shell; the main column can be far narrower than the window (an
// open sidebar, a split view, a phone), so a viewport media query alone would be
// wrong. The `agy-console-tabs` class is kept as an alias on the tab strip so
// the legacy phone rules in global-css.ts (and their regression test) still
// apply.

export const APP_CSS = `
/* ---- root surface ------------------------------------------------------- */
.agy2-root {
	height: 100%;
	min-height: 0;
	background: var(--agy-bg-panel, transparent);
	color: var(--agy-text-primary, inherit);
	font-family: var(--agy-font-family);
	line-height: 1.5;
	font-size: 13px;
	box-sizing: border-box;
}
.agy2-root *,
.agy2-root *::before,
.agy2-root *::after { box-sizing: border-box; }
.agy2-surface {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
}

/* ---- app header --------------------------------------------------------- */
.agy2-header {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 14px 18px;
	border-bottom: 1px solid var(--agy-border-divider, rgba(128,128,128,.18));
	background: var(--agy-bg-header, transparent);
	flex: 0 0 auto;
}
.agy2-mark {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 38px;
	height: 38px;
	border-radius: 11px;
	background: linear-gradient(140deg, var(--agy-bg-card-primary, #eaf2ff), var(--agy-bg-subbox, #f1f5f9));
	border: 1px solid var(--agy-border-card, rgba(128,128,128,.2));
	flex-shrink: 0;
	box-shadow: var(--agy-shadow-card, none);
}
.agy2-headtitles { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.agy2-title {
	margin: 0;
	font-size: 16px;
	font-weight: 700;
	letter-spacing: -0.01em;
	color: var(--agy-text-primary, inherit);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.agy2-subtitle {
	margin: 0;
	font-size: 11.5px;
	line-height: 16px;
	color: var(--agy-text-tertiary, inherit);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.agy2-headactions { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }

/* status pill */
.agy2-pill {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	padding: 3px 9px;
	border-radius: 999px;
	font-size: 11px;
	font-weight: 600;
	white-space: nowrap;
	border: 1px solid transparent;
	flex-shrink: 0;
}
.agy2-pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .9; }
.agy2-pill[data-tone="ok"] {
	background: var(--agy-badge-ready-bg, rgba(31,143,95,.13));
	color: var(--agy-badge-ready-text, #1f8f5f);
	border-color: var(--agy-badge-ready-border, rgba(31,143,95,.3));
}
.agy2-pill[data-tone="warn"] {
	background: var(--agy-badge-warn-bg, rgba(184,121,26,.14));
	color: var(--agy-badge-warn-text, #b8791a);
	border-color: var(--agy-badge-warn-border, rgba(184,121,26,.3));
}

/* ---- body + scroll ------------------------------------------------------ */
.agy2-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.agy2-scroll {
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	padding: 14px 18px 28px;
	scrollbar-width: thin;
}

/* ---- app tab strip ------------------------------------------------------ */
.agy2-tabs {
	display: flex;
	align-items: stretch;
	gap: 2px;
	padding: 0 12px;
	border-bottom: 1px solid var(--agy-border-divider, rgba(128,128,128,.18));
	background: var(--agy-bg-header, transparent);
	flex: 0 0 auto;
	overflow-x: auto;
	overscroll-behavior-x: contain;
	scrollbar-width: none;
}
.agy2-tabs::-webkit-scrollbar { display: none; }
.agy2-tab {
	position: relative;
	display: inline-flex;
	align-items: center;
	gap: 7px;
	padding: 11px 12px 10px;
	border: none;
	background: transparent;
	color: var(--agy-text-tertiary, inherit);
	font: inherit;
	font-size: 12.5px;
	font-weight: 600;
	cursor: pointer;
	white-space: nowrap;
	flex: 0 0 auto;
	transition: color .14s ease;
}
.agy2-tab:hover { color: var(--agy-text-secondary, inherit); }
.agy2-tab[aria-selected="true"] { color: var(--agy-text-window-label, #2563eb); }
.agy2-tab[aria-selected="true"]::after {
	content: '';
	position: absolute;
	left: 8px; right: 8px; bottom: -1px;
	height: 2px;
	border-radius: 2px 2px 0 0;
	background: var(--agy-text-window-label, #2563eb);
}
.agy2-tab-ico { display: inline-flex; align-items: center; color: inherit; opacity: .9; }
.agy2-tab-count {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-width: 18px;
	height: 17px;
	padding: 0 5px;
	border-radius: 999px;
	font-size: 10.5px;
	font-weight: 700;
	font-variant-numeric: tabular-nums;
	background: var(--agy-badge-tag-bg, rgba(128,128,128,.16));
	color: var(--agy-text-secondary, inherit);
}
.agy2-tab[aria-selected="true"] .agy2-tab-count {
	background: var(--agy-badge-primary-bg, rgba(37,99,235,.15));
	color: var(--agy-badge-primary-text, #1e40af);
}

/* ---- stack + cards ------------------------------------------------------ */
.agy2-stack { display: flex; flex-direction: column; gap: 12px; }
.agy2-card {
	border: 1px solid var(--agy-border-card, rgba(128,128,128,.2));
	border-radius: 12px;
	background: var(--agy-bg-card, transparent);
	box-shadow: var(--agy-shadow-card, none);
	overflow: hidden;
	display: flex;
	flex-direction: column;
}
.agy2-card-head {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 11px 14px;
	border-bottom: 1px solid var(--agy-border-divider, rgba(128,128,128,.16));
	min-height: 40px;
}
.agy2-card-ico { display: inline-flex; align-items: center; color: var(--agy-text-tertiary, inherit); flex-shrink: 0; }
.agy2-card-title {
	font-size: 12.5px;
	font-weight: 700;
	letter-spacing: .01em;
	color: var(--agy-text-primary, inherit);
	flex: 1 1 auto;
	min-width: 0;
}
.agy2-card-right { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.agy2-card-body {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 12px 14px;
}
.agy2-card-body[data-flush="true"] { padding: 0; }

/* ---- section sub-heading inside a tab ----------------------------------- */
.agy2-lede {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 0 2px 2px;
}
.agy2-lede-title { font-size: 12.5px; font-weight: 700; color: var(--agy-text-primary, inherit); }

/* ---- buttons ------------------------------------------------------------ */
.agy2-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 5px;
	padding: 0 11px;
	height: 28px;
	border-radius: 7px;
	border: 1px solid var(--agy-border-btn, rgba(128,128,128,.28));
	background: var(--agy-bg-btn, transparent);
	color: var(--agy-text-btn, inherit);
	font: inherit;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	white-space: nowrap;
	transition: background .14s ease, border-color .14s ease, opacity .14s ease;
}
.agy2-btn:hover:not(:disabled) { background: var(--agy-bg-btn-hover, rgba(128,128,128,.12)); }
.agy2-btn:disabled { opacity: .55; cursor: default; }
.agy2-btn[data-variant="primary"] {
	background: var(--agy-bg-btn-primary, #2563eb);
	border-color: var(--agy-border-btn-primary, #2563eb);
	color: var(--agy-btn-primary-text, #fff);
}
.agy2-btn[data-variant="primary"]:hover:not(:disabled) { filter: brightness(1.05); }

/* ---- field group (keep host widgets readable in the new frames) --------- */
.agy2-card-body .agy-row { min-width: 0; }

/* ---- empty state -------------------------------------------------------- */
.agy2-empty {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	text-align: center;
	gap: 8px;
	padding: 44px 20px;
	color: var(--agy-text-tertiary, inherit);
	font-size: 13px;
}
.agy2-empty-title { font-size: 14px; font-weight: 600; color: var(--agy-text-secondary, inherit); }
.agy2-empty-hint { font-size: 12px; max-width: 320px; line-height: 1.55; }

/* ---- narrow reflow (measured width, not viewport) ----------------------- */
.agy2-root[data-narrow="true"] .agy2-header { padding: 10px 13px; gap: 9px; flex-wrap: wrap; }
.agy2-root[data-narrow="true"] .agy2-mark { width: 32px; height: 32px; border-radius: 9px; }
.agy2-root[data-narrow="true"] .agy2-title { font-size: 14.5px; }
.agy2-root[data-narrow="true"] .agy2-subtitle { display: none; }
.agy2-root[data-narrow="true"] .agy2-headactions { width: 100%; }
.agy2-root[data-narrow="true"] .agy2-headactions .agy2-btn { flex: 1 1 0; height: 32px; }
.agy2-root[data-narrow="true"] .agy2-tabs { padding: 0 6px; }
.agy2-root[data-narrow="true"] .agy2-tab { padding: 10px 9px 9px; font-size: 12px; }
.agy2-root[data-narrow="true"] .agy2-scroll { padding: 12px 12px calc(20px + env(safe-area-inset-bottom, 0px)); -webkit-overflow-scrolling: touch; }
.agy2-root[data-narrow="true"] .agy2-card-head { padding: 10px 12px; }
.agy2-root[data-narrow="true"] .agy2-card-body { padding: 11px 12px; }
`;
