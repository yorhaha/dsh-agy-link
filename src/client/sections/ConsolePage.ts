// Full-page Antigravity console: the page opened by the sidebar entry.
//
// The sidebar (slot `sidebar.panellist`) shows a small brand glyph; selecting
// it puts this page into the `main` column keyed by the panel id. The page is a
// thin shell over `AgySettingsSection` in `layout: 'page'` mode: it measures its
// own box and reports a `narrow` class so the inner console can stack on a
// phone (or any narrow split view) without relying on a viewport media query —
// the main column can be far narrower than the window.
import type { LocaleLike } from '../hooks/useTranslation.ts';
import { agyIcon } from '../icons.ts';
import { h, useEffect, useRef, useState } from '../react.ts';
import type { SettingsSectionProps } from './SettingsSection.ts';

/** Below this measured content width the two-column card layouts stack. */
const NARROW_WIDTH = 640;

/**
 * Track one element's own width. A ResizeObserver is used when present; the
 * window resize event is the fallback. Values start from the window width so
 * the first paint is never wider than the real panel.
 */
function useElementWidth(ref: { current: HTMLElement | null }): number {
	const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1200 : window.innerWidth));
	useEffect(() => {
		const element = ref.current;
		if (element === null || typeof element?.getBoundingClientRect !== 'function') return undefined;
		const measure = (): void => {
			const next = element.getBoundingClientRect().width;
			if (next > 0) setWidth(next);
		};
		measure();
		if (typeof ResizeObserver === 'undefined') {
			window.addEventListener('resize', measure);
			return () => window.removeEventListener('resize', measure);
		}
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

/**
 * The sidebar panel glyph. The slot owner passes `{ size, active }`; the mark
 * brightens when this panel is the selected one, matching the shell's rail.
 */
export function AgyPanelIcon(props?: { size?: number; active?: boolean }): unknown {
	const size = props?.size ?? 20;
	return h('span', {
		className: 'agy-panel-glyph',
		'data-active': props?.active === true ? 'true' : 'false',
		style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size },
	}, agyIcon(size));
}

/**
 * Build the page component. `Section` is the console body factory from
 * `createSettingsSection`; it is reused verbatim in `layout: 'page'` so the
 * panel behaves exactly as in the settings dialog — only the chrome differs.
 */
export function createConsolePage(
	Section: (props?: SettingsSectionProps) => unknown,
): (props?: unknown) => unknown {
	return function AgyConsolePage(): unknown {
		const ref = useRef<HTMLDivElement | null>(null);
		const width = useElementWidth(ref);
		const narrow = width < NARROW_WIDTH;
		return h('div', {
			ref,
			className: 'agy2-root',
			'data-narrow': narrow ? 'true' : 'false',
		}, Section({ layout: 'page' }));
	};
}
