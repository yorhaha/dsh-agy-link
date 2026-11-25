// Issue #105: the header status badge is user-hideable. These tests drive the
// real components (SSR for the header, jsdom-free pure helpers for the
// visibility rule) instead of string-matching a bundle, so a refactor cannot
// silently drop the switch.
import './helpers/client-render.ts';
import { React, renderToStaticMarkup } from './helpers/client-render.ts';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	disposeStatusPolling,
	isUiVisible,
	publishStatusSnapshot,
	type StatusPayload,
} from '../src/client/status.ts';
import { createSessionStatus } from '../src/client/sections/SessionStatus.ts';
import { renderHeaderBadgeRow } from '../src/client/sections/VisibilityRows.ts';

const createElement = (React as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown }).createElement;

const locale = {
	subscribe: () => () => {},
	bind: () => (key: string) => key,
};

const SettingsSection = () => null;

function renderBadge(): string {
	const Badge = createSessionStatus(locale, SettingsSection);
	return renderToStaticMarkup(createElement(Badge));
}

test('isUiVisible is opt-out: only an explicit false hides an affordance', () => {
	assert.equal(isUiVisible(null, 'showHeaderBadge'), true, 'no status yet (startup) stays visible')
	assert.equal(isUiVisible({}, 'showHeaderBadge'), true, 'older hosts without the field stay visible')
	assert.equal(isUiVisible({ showHeaderBadge: true }, 'showHeaderBadge'), true)
	assert.equal(isUiVisible({ showHeaderBadge: false }, 'showHeaderBadge'), false)
})

test('visibility rows: the badge switch renders and writes the correct config key', () => {
	const written: Array<[string, unknown]> = []
	const row = renderHeaderBadgeRow({
		t: ((key: string) => key) as never,
		status: { showHeaderBadge: false },
		loadingAction: 'config:showHeaderBadge',
		setCfg: async (key, value) => { written.push([key, value]) },
	}) as { props: { right: { props: { children: Array<{ props: { onClick: () => void; disabled: boolean; variant: string } }> } } } }
	const html = renderToStaticMarkup(createElement('div', null, row))
	assert.match(html, /config\.showHeaderBadge/)

	// The hidden row marks "off" active and disables its buttons while a write
	// is in flight.
	const headerButtons = row.props.right.props.children
	assert.equal(headerButtons[0]!.props.variant, 'seg')
	assert.equal(headerButtons[1]!.props.variant, 'segActive')
	assert.equal(headerButtons[0]!.props.disabled, true)

	for (const button of row.props.right.props.children) button.props.onClick()
	assert.deepEqual(written, [
		['showHeaderBadge', true], ['showHeaderBadge', false],
	])
})

test('issue #105: an explicit status opt-out removes the header badge but keeps the console portal', () => {
	try {
		publishStatusSnapshot({ showHeaderBadge: true } satisfies StatusPayload)
		assert.match(renderBadge(), /agy-session-status-btn/, 'badge is visible by default')

		publishStatusSnapshot({ showHeaderBadge: false } satisfies StatusPayload)
		assert.doesNotMatch(renderBadge(), /agy-session-status-btn/, 'badge must not render when hidden')

		publishStatusSnapshot({ showHeaderBadge: true } satisfies StatusPayload)
		assert.match(renderBadge(), /agy-session-status-btn/, 'turning the switch back on restores the badge')
	} finally {
		publishStatusSnapshot({ showHeaderBadge: true } satisfies StatusPayload)
		disposeStatusPolling()
	}
})
