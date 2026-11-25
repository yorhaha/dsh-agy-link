// Issue #105: the user-hideable affordance. The switch is pure presentation —
// the single source of truth is the /status snapshot (see .spec/ui-visibility.md).
import { h } from '../react.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import type { StatusPayload } from '../status.ts';
import { Button } from '../ui/Button.ts';
import { Row, rowCaption } from '../ui/Row.ts';
import { segGroup } from '../ui/SegGroup.ts';

interface VisibilityRowOptions {
	t: Translator;
	label: Parameters<Translator>[0];
	desc: Parameters<Translator>[0];
	key: 'showHeaderBadge';
	visible: boolean;
	loadingAction: string | null;
	setCfg: (key: string, value: unknown) => Promise<void>;
}

function visibilityRow(o: VisibilityRowOptions): unknown {
	return h(Row, {
		key: 'vis-' + o.key,
		left: rowCaption(o.t(o.label), o.t(o.desc)),
		right: segGroup([
			h(Button, {
				variant: o.visible ? 'segActive' : 'seg',
				disabled: o.loadingAction === 'config:' + o.key,
				onClick: () => void o.setCfg(o.key, true),
			}, o.t('config.on')),
			h(Button, {
				variant: !o.visible ? 'segActive' : 'seg',
				disabled: o.loadingAction === 'config:' + o.key,
				onClick: () => void o.setCfg(o.key, false),
			}, o.t('config.off')),
		]),
	});
}

/** Conversation header badge visibility row. */
export function renderHeaderBadgeRow(args: {
	t: Translator;
	status: StatusPayload;
	loadingAction: string | null;
	setCfg: (key: string, value: unknown) => Promise<void>;
}): unknown {
	return visibilityRow({
		t: args.t,
		loadingAction: args.loadingAction,
		setCfg: args.setCfg,
		label: 'config.showHeaderBadge',
		desc: 'config.showHeaderBadgeDesc',
		key: 'showHeaderBadge',
		visible: args.status.showHeaderBadge !== false,
	});
}
