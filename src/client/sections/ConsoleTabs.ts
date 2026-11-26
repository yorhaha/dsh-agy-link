// Modular console tabs and card-grouped panels for SettingsSection.
// Separates high-frequency account/quota controls from model/orchestrator setup,
// assistants, and low-frequency runtime settings.
import type { AccountPoolData, ManagedAccount } from '../../common/pool-types.ts';
import type { QuotaFamily } from '../../common/quota-bench.ts';
import { modelMatches } from '../../common/pool-types.ts';
import {
	catalogEfforts,
	type EffortLabels,
} from '../config-options.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import { h } from '../react.ts';
import type { CatalogModelView, StatusPayload } from '../status.ts';
import { agyGlyph, type AgyGlyphName } from '../agy-glyph.ts';
import { Button } from '../ui/Button.ts';
import { Row, rowCaption } from '../ui/Row.ts';
import { segGroup } from '../ui/SegGroup.ts';
import { AccountsPanel, type AccountsPanelHandlers } from './AccountsPanel.ts';
import { renderPoolWideCatalogRow } from './CatalogRows.ts';
import { ModelsPanel } from './ModelsPanel.ts';
import { renderOrchestratorRows } from './OrchestratorSettingsRows.ts';
import { RuntimeControlsSection } from './RuntimeControlsRows.ts';
import { renderHeaderBadgeRow } from './VisibilityRows.ts';

export type ConsoleTabId = 'accounts' | 'models' | 'features' | 'runtime';

export interface ConsoleTabsProps {
	t: Translator;
	activeTab: ConsoleTabId;
	onSelectTab: (tab: ConsoleTabId) => void;
	status: StatusPayload;
	pool: AccountPoolData | undefined;
	accounts: ManagedAccount[];
	accountModels?: Readonly<Record<string, ReadonlyArray<CatalogModelView>>>;
	catalogModels: ReadonlyArray<CatalogModelView>;
	hiddenModelSet: Set<string>;
	selectedModelSet: Set<string>;
	loadingAction: string | null;
	effortLabels: EffortLabels;
	addAccountSection: unknown;
	proxyInputs: Record<string, string>;
	setProxyInputs: (next: Record<string, string>) => void;
	editingProxyId: string | null;
	setEditingProxyId: (id: string | null) => void;
	aliasInputs: Record<string, string>;
	setAliasInputs: (next: Record<string, string>) => void;
	editingAliasId: string | null;
	setEditingAliasId: (id: string | null) => void;
	expandedModels: Record<string, boolean>;
	toggleExpand: (accId: string) => void;
	optimisticActiveByFamily: Partial<Record<QuotaFamily, string>>;
	accountHandlers: AccountsPanelHandlers;
	setCfg: (key: string, value: unknown) => Promise<void>;
	setSelectedModels: (ids: ReadonlyArray<string>) => Promise<void>;
	setHiddenModels: (ids: ReadonlyArray<string>) => Promise<void>;
}

function sectionCard(key: string, title: string, children: unknown[], rightHead?: unknown, icon?: AgyGlyphName): unknown {
	return h('div', { key, className: 'agy2-card' },
		h('div', { className: 'agy2-card-head' },
			icon !== undefined ? h('span', { className: 'agy2-card-ico' }, agyGlyph(icon, 15)) : null,
			h('span', { className: 'agy2-card-title' }, title),
			rightHead !== undefined ? h('span', { className: 'agy2-card-right' }, rightHead) : null,
		),
		h('div', { className: 'agy2-card-body' }, ...children),
	);
}

function visibleModelCount(
	catalogModels: ReadonlyArray<CatalogModelView>,
	hiddenModelSet: Set<string>,
	selectedModelSet: Set<string>,
): number {
	if (catalogModels.length === 0) return 0;
	const unrestricted = selectedModelSet.size === 0;
	const selected = Array.from(selectedModelSet);
	return catalogModels.filter((m) =>
		!hiddenModelSet.has(m.id) && (unrestricted || selected.some((w) => modelMatches(w, m.id))),
	).length;
}

export function renderConsoleTabBar(params: {
	t: Translator;
	activeTab: ConsoleTabId;
	onSelectTab: (tab: ConsoleTabId) => void;
	accountCount: number;
	visibleModels: number;
	totalModels: number;
}): unknown {
	const { t, activeTab, onSelectTab, accountCount, visibleModels, totalModels } = params;
	const tabs: Array<{ id: ConsoleTabId; label: string; icon: AgyGlyphName; badge?: string }> = [
		{ id: 'accounts', label: t('tab.accounts'), icon: 'globe', badge: String(accountCount) },
		{
			id: 'models',
			label: t('tab.models'),
			icon: 'star',
			...(totalModels > 0 ? { badge: `${visibleModels}/${totalModels}` } : {}),
		},
		{ id: 'features', label: t('tab.features'), icon: 'zap' },
		{ id: 'runtime', label: t('tab.runtime'), icon: 'power' },
	];
	return h('div', { className: 'agy2-tabs agy-console-tabs', role: 'tablist' },
		...tabs.map((tab) => {
			const active = activeTab === tab.id;
			return h('button', {
				key: tab.id,
				type: 'button',
				role: 'tab',
				className: 'agy2-tab',
				'aria-selected': active,
				'data-tab': tab.id,
				onClick: () => onSelectTab(tab.id),
			},
				h('span', { className: 'agy2-tab-ico' }, agyGlyph(tab.icon, 15)),
				h('span', null, tab.label),
				tab.badge !== undefined ? h('span', { className: 'agy2-tab-count' }, tab.badge) : null,
			);
		}),
	);
}

function renderAccountsTab(p: ConsoleTabsProps): unknown {
	const { t, status, pool, accounts, loadingAction } = p;

	return h('div', { className: 'agy2-stack' },
		p.addAccountSection,
		h('div', { className: 'agy2-lede' },
			h('span', { className: 'agy2-lede-title' }, t('account.poolHeading', { count: accounts.length })),
		),
		h(AccountsPanel, {
			t, pool, accounts, accountModels: p.accountModels, loadingAction,
			quotaRefreshing: status.quotaRefreshing ?? [],
			proxyInputs: p.proxyInputs, setProxyInputs: p.setProxyInputs,
			editingProxyId: p.editingProxyId, setEditingProxyId: p.setEditingProxyId,
			aliasInputs: p.aliasInputs, setAliasInputs: p.setAliasInputs,
			editingAliasId: p.editingAliasId, setEditingAliasId: p.setEditingAliasId,
			expandedModels: p.expandedModels, toggleExpand: p.toggleExpand,
			optimisticActiveByFamily: p.optimisticActiveByFamily,
			handlers: p.accountHandlers,
		}),
	);
}

function renderDefaultEffortRow(p: ConsoleTabsProps): unknown {
	const { t, status, catalogModels, loadingAction, setCfg, effortLabels } = p;
	const value = status.defaultEffort;
	const levels = catalogEfforts(catalogModels);
	const configured = (value ?? '').trim().toLowerCase();
	const shown = configured !== '' && !levels.includes(configured) ? [...levels, configured] : levels;
	return h(Row, {
		key: 'default-effort',
		left: rowCaption(t('config.defaultEffort'), t('config.defaultEffortDesc')),
		right: segGroup([
			h(Button, {
				variant: value === '' ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:defaultEffort',
				onClick: () => void setCfg('defaultEffort', ''),
			}, t('effort.auto')),
			...shown.map((level) => h(Button, {
				key: level,
				variant: value === level ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:defaultEffort',
				onClick: () => void setCfg('defaultEffort', level),
			}, effortLabels.level(level))),
		]),
	});
}

function renderModelsTab(p: ConsoleTabsProps): unknown {
	const { t, status, catalogModels, hiddenModelSet, selectedModelSet, loadingAction, setCfg } = p;
	return h('div', { className: 'agy2-stack' },
		sectionCard('model-catalog', t('section.modelCatalog'), [
			renderPoolWideCatalogRow({ t, status, loadingAction, setCfg }),
			h('div', { key: 'div', style: { borderTop: '1px solid var(--agy-border-divider)', paddingTop: '8px' } },
				h(ModelsPanel, {
					t, catalogModels, hiddenModelSet, selectedModelSet, loadingAction,
					setSelectedModels: p.setSelectedModels, setHiddenModels: p.setHiddenModels,
				}),
			),
		], undefined, 'star'),
		sectionCard('thinking-orch', t('section.thinkingOrchestrator'), [
			renderDefaultEffortRow(p),
			...renderOrchestratorRows(t, status, catalogModels, loadingAction, setCfg, p.effortLabels),
		], undefined, 'zap'),
	);
}

function renderFeaturesTab(p: ConsoleTabsProps): unknown {
	const { t, status, loadingAction, setCfg } = p;
	return h('div', { className: 'agy2-stack' },
		sectionCard('slash-commands', t('section.slashCommands'), [
			h(Row, {
				key: 'slash-direct',
				left: rowCaption(t('slash.directTitle'), t('slash.directDesc')),
				right: h('code', { style: { fontSize: '11px', color: 'var(--agy-text-secondary)', wordBreak: 'break-word' } }, t('slash.directList')),
			}),
			h(Row, {
				key: 'slash-meta',
				left: rowCaption(t('slash.metaTitle'), t('slash.metaDesc')),
				right: h('code', { style: { fontSize: '11px', color: 'var(--agy-text-secondary)', wordBreak: 'break-word' } }, t('slash.metaList')),
			}),
		], undefined, 'zap'),
		sectionCard('ui-display', t('section.uiDisplay'), [
			renderHeaderBadgeRow({ t, status, loadingAction, setCfg }),
		], undefined, 'star'),
	);
}

function renderRuntimeTab(p: ConsoleTabsProps): unknown {
	const { t, status, loadingAction, setCfg } = p;
	return h('div', { className: 'agy2-stack' },
		sectionCard('execution', t('section.execution'), [
			h(RuntimeControlsSection, {
				t, status, loadingAction, setCfg,
			}),
		], undefined, 'power'),
	);
}

export function renderConsoleTabContent(p: ConsoleTabsProps): unknown {
	const visible = visibleModelCount(p.catalogModels, p.hiddenModelSet, p.selectedModelSet);
	const bar = renderConsoleTabBar({
		t: p.t,
		activeTab: p.activeTab,
		onSelectTab: p.onSelectTab,
		accountCount: p.accounts.length,
		visibleModels: visible,
		totalModels: p.catalogModels.length,
	});
	const body = p.activeTab === 'models'
		? renderModelsTab(p)
		: p.activeTab === 'features'
			? renderFeaturesTab(p)
			: p.activeTab === 'runtime'
				? renderRuntimeTab(p)
				: renderAccountsTab(p);
	return h('div', { className: 'agy2-body' }, bar, h('div', { className: 'agy2-scroll' }, body));
}
