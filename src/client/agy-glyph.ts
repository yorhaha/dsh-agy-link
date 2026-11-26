// Outline glyph set for the console chrome, in the reference-plugins' stroke
// language (../dsh-plugins/file-memory): a single `Glyph` that draws every icon
// with viewBox 0 0 24 24, fill none, stroke currentColor, round caps/joins and a
// ~1.7 stroke weight. Self-contained on purpose — the console paints its own
// icons instead of borrowing the host `uiIcon` set (which is a heavier,
// filled-stroke style), so the whole surface reads as one consistent family.

import { h } from './react.ts';

export type AgyGlyphName =
	| 'globe'
	| 'star'
	| 'zap'
	| 'power'
	| 'plus'
	| 'refresh'
	| 'check'
	| 'alert'
	| 'externalLink'
	| 'arrowDown'
	| 'sparkle'
	| 'sliders';

/**
 * Draw one console glyph. `size` is the box in px (default 14), `color` the
 * stroke paint (default `currentColor` so it inherits the surrounding text).
 */
export function agyGlyph(name: AgyGlyphName, size = 14, color = 'currentColor'): unknown {
	const common = {
		width: size,
		height: size,
		viewBox: '0 0 24 24',
		fill: 'none',
		stroke: color,
		strokeWidth: 1.7,
		strokeLinecap: 'round',
		strokeLinejoin: 'round',
		'aria-hidden': true,
		focusable: false,
		style: { flexShrink: 0, display: 'inline-block', verticalAlign: '-2px' },
	};
	switch (name) {
		case 'globe':
			return h('svg', common,
				h('circle', { cx: 12, cy: 12, r: 8.5 }),
				h('path', { d: 'M3.5 12h17' }),
				h('path', { d: 'M12 3.5c2.6 2.4 4 5.4 4 8.5s-1.4 6.1-4 8.5c-2.6-2.4-4-5.4-4-8.5s1.4-6.1 4-8.5z' }));
		case 'star':
			return h('svg', common,
				h('path', { d: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 17l-5.2 2.6 1-5.8-4.2-4.1 5.8-.8z' }));
		case 'zap':
			return h('svg', common,
				h('path', { d: 'M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z' }));
		case 'power':
			return h('svg', common,
				h('path', { d: 'M12 3.5v8' }),
				h('path', { d: 'M6.8 6.8a8 8 0 1 0 10.4 0' }));
		case 'plus':
			return h('svg', common, h('path', { d: 'M12 5v14M5 12h14' }));
		case 'refresh':
			return h('svg', common,
				h('path', { d: 'M20 12a8 8 0 1 1-2.4-5.7' }),
				h('path', { d: 'M20 4.2v5h-5' }));
		case 'check':
			return h('svg', common, h('path', { d: 'M5 12.5l4.5 4.5L19 7.5' }));
		case 'alert':
			return h('svg', common,
				h('path', { d: 'M12 4.5l9 15.5H3z' }),
				h('path', { d: 'M12 10v4.2' }),
				h('path', { d: 'M12 17.2v.2' }));
		case 'externalLink':
			return h('svg', common,
				h('path', { d: 'M14 4h6v6' }),
				h('path', { d: 'M20 4l-8.5 8.5' }),
				h('path', { d: 'M19 14v5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5h5' }));
		case 'arrowDown':
			return h('svg', common,
				h('path', { d: 'M12 4v15' }),
				h('path', { d: 'M6 13l6 6 6-6' }));
		case 'sparkle':
			return h('svg', common,
				h('path', { d: 'M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8z' }),
				h('path', { d: 'M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z' }));
		case 'sliders':
			return h('svg', common,
				h('path', { d: 'M4 8h10M18 8h2M4 16h3M11 16h9' }),
				h('circle', { cx: 16, cy: 8, r: 2 }),
				h('circle', { cx: 9, cy: 16, r: 2 }));
		default:
			return null;
	}
}
