// The one account card: header (status dot, actions, email/auth/proxy badges)
// and per-family quota blocks (Gemini, Argon, Claude, GPT-OSS) with their
// cooldown controls.
//
// Rendering lives here; async actions come in as handlers from useAccounts so
// busy scoping and host-derived progress survive modal close/reopen.

import { buildAccountModelRows, type AccountModelDisplayItem } from '../../common/account-models.ts';
import { argonSharesGoogleGroup, type AccountPlanTier, type AccountPoolData, type ManagedAccount } from '../../common/pool-types.ts';
import { resolveFamilyActiveIds } from './active-account-ids.ts';
import { accountDisplayAlias as aliasOf, type AliasTranslator } from './account-alias.ts';
import { resolveAccountPlanTier } from '../../common/plan-tier.ts';
import {
	QUOTA_FAMILIES,
	accountAuthState,
	isAccountFullyCooling,
	isFamilyCooling,
	isFamilyInCooldown,
	type AccountAuthState,
	type QuotaFamily,
} from '../../common/quota-bench.ts';
import { effortLabel } from '../../common/reasoning.ts';
import type { CatalogModelView } from '../status.ts';
import { h } from '../react.ts';
import { S } from '../styles.ts';
import { uiIcon } from '../icons.ts';
import { Button } from '../ui/Button.ts';
import { Spinner } from '../ui/Spinner.ts';
import { renderInlineEditor } from './inline-editor.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import { formatQuotaWindow, renderFamilyQuotaBar, renderQuotaUnavailableNote } from './QuotaPanel.ts';

export interface AccountsPanelHandlers {
	beginReauth?: (acc: ManagedAccount) => Promise<void>;
	refreshQuota: () => Promise<void>;
	saveProxy: (id: string) => Promise<void>;
	saveAlias: (id: string) => Promise<void>;
	clearCooldown: (id?: string, family?: QuotaFamily) => Promise<void>;
}

export interface AccountsPanelProps {
	t: Translator;
	pool: AccountPoolData | undefined;
	accounts: ManagedAccount[];
	accountModels?: Readonly<Record<string, ReadonlyArray<CatalogModelView>>>;
	loadingAction: string | null;
	/** Account ids the HOST reports as refreshing right now (survives modal close/reopen). */
	quotaRefreshing?: readonly string[];
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
	handlers: AccountsPanelHandlers;
}

export function AccountsPanel(props: AccountsPanelProps): unknown {
	const {
		t, pool, accounts, accountModels, loadingAction, quotaRefreshing = [],
		proxyInputs, setProxyInputs, editingProxyId, setEditingProxyId, aliasInputs, setAliasInputs,
		editingAliasId, setEditingAliasId, expandedModels, toggleExpand, handlers,
	} = props;

	const accountActionBusy = (acc: ManagedAccount, action: string): boolean =>
		loadingAction === `${action}:${acc.id}`;

	const activeIds = resolveFamilyActiveIds(pool);
	const now = Date.now();

	return accounts.map((acc: ManagedAccount) => {
		const authState = accountAuthState(acc);
		const isAuthRequired = authState !== 'healthy';
		const isFullyCooling = isAccountFullyCooling(acc, now);
		const isSyncing = loadingAction === `refresh:${acc.id}` || loadingAction === 'refresh:all' || quotaRefreshing.includes(acc.id);
		const dotColor = !acc.enabled ? '#64748b' : authState === 'review' ? '#f59e0b' : isAuthRequired ? '#ef4444' : isFullyCooling ? '#f59e0b' : '#10b981';
		const isEditingProxy = editingProxyId === acc.id;
		const isEditingAlias = editingAliasId === acc.id;
		const isExpanded = expandedModels[acc.id] ?? false;
		const accIndex = accounts.indexOf(acc);

		const cardStyle = {
			...S.card!,
			cursor: 'default',
			padding: '10px 14px',
			marginBottom: '8px',
			...(!acc.enabled ? { opacity: 0.72 } : {}),
		};
		const displayAlias = accountDisplayAlias(acc, accIndex, t);

		const childModels = buildAccountModelRows(acc, accountModels?.[acc.id]);
		const renderQuotaBar = (label: string, familyKey: QuotaFamily): unknown => {
			const cooling = isFamilyCooling(acc, familyKey, now);
			const isFamActive = Boolean(acc.enabled && !isAuthRequired && !cooling && activeIds[familyKey] === acc.id);
			return renderFamilyQuotaBar(t, label, familyKey, acc, isSyncing, {
				isActive: isFamActive,
				clearingCooldown: loadingAction === `clearCooldown:${acc.id}:${familyKey}`,
				onClearCooldown: () => void handlers.clearCooldown(acc.id, familyKey),
			});
		};
		const collapsedCoolingNames = (['anthropic', 'openai'] as const)
			.filter((fam) => isFamilyCooling(acc, fam, now))
			.map((fam) => (fam === 'anthropic' ? 'Claude' : 'GPT-OSS'));

		return h('div', {
			key: acc.id,
			className: 'agy-card-hover',
			style: cardStyle,
		},
			renderCardHeader(t, acc, {
				isAuthRequired, authState, dotColor, isEditingProxy, isSyncing, isEditingAlias,
				displayAlias, accountModelIds: accountModels?.[acc.id]?.map((m) => m.id), pool, loadingAction, accountActionBusy, handlers, setEditingProxyId, setEditingAliasId,
			}),
			h('div', { key: 'agy-body', style: S.quotaBox },
				renderQuotaUnavailableNote(t, acc),
				renderQuotaBar('Gemini', 'google'),
				(acc.quotas.argon || (!argonSharesGoogleGroup(acc) && isFamilyInCooldown(acc, 'argon', now))) ? renderQuotaBar('Argon', 'argon') : null,
				h(Button, {
					variant: 'dashed',
					style: {
						color: isExpanded ? 'var(--dsw-alias-state-business-primary, #3b82f6)' : 'var(--agy-text-secondary)',
						padding: '3px 8px',
						fontSize: '11px',
						margin: '4px 0 2px 0',
						gap: '4px',
					},
					onClick: () => toggleExpand(acc.id),
				},
					uiIcon(isExpanded ? 'chevronUp' : 'chevronDown', 10),
					h('span', null, isExpanded ? t('account.collapseOthers') : t('account.expandOthers')),
					!isExpanded && collapsedCoolingNames.length > 0
						? h('span', { style: { color: '#f59e0b', fontWeight: 700 } }, t('account.collapsedCoolingHint', { families: collapsedCoolingNames.join(', ') }))
						: null,
				),
				isExpanded ? h('div', { key: 'expanded-details' },
					renderQuotaBar('Claude', 'anthropic'),
					renderQuotaBar('GPT-OSS', 'openai'),
					childModels.length > 0 ? renderChildModels(t, childModels) : null,
				) : null,
			),
			isEditingAlias ? renderAliasEditor(t, acc, aliasInputs, setAliasInputs, setEditingAliasId, displayAlias, loadingAction, accountActionBusy, handlers) : null,
			isEditingProxy ? renderProxyEditor(t, acc, pool, proxyInputs, setProxyInputs, setEditingProxyId, loadingAction, accountActionBusy, handlers) : null,
		);
	});
}

/** Card label: a generated default alias is re-rendered in the active locale. */
function accountDisplayAlias(acc: ManagedAccount, accIndex: number, t: Translator): string {
	return aliasOf(t as unknown as AliasTranslator, acc, accIndex);
}

interface CardHeaderCtx {
	isAuthRequired: boolean;
	authState: AccountAuthState;
	dotColor: string;
	isEditingProxy: boolean;
	isEditingAlias: boolean;
	isSyncing: boolean;
	displayAlias: string;
	accountModelIds?: readonly string[];
	pool: AccountPoolData | undefined;
	loadingAction: string | null;
	accountActionBusy: (acc: ManagedAccount, action: string) => boolean;
	handlers: AccountsPanelHandlers;
	setEditingProxyId: (id: string | null) => void;
	setEditingAliasId: (id: string | null) => void;
}

function extractActionUrl(text?: string): string | undefined {
	if (!text) return undefined;
	const m = text.match(/https:\/\/[^\s)\]>.,;"']+/);
	return m ? m[0] : undefined;
}

function renderPlanTierBadge(t: Translator, tier: AccountPlanTier | undefined): unknown {
	if (!tier || tier === 'unknown') return null;
	const palette: Record<Exclude<AccountPlanTier, 'unknown'>, { bg: string; text: string; border: string }> = {
		ultra: { bg: 'rgba(139, 92, 246, 0.14)', text: '#8b5cf6', border: 'rgba(139, 92, 246, 0.4)' },
		pro: { bg: 'rgba(59, 130, 246, 0.14)', text: '#3b82f6', border: 'rgba(59, 130, 246, 0.4)' },
		free: { bg: 'var(--agy-bg-subbox)', text: 'var(--agy-text-secondary)', border: 'var(--agy-border-subbox)' },
		enterprise: { bg: 'rgba(16, 185, 129, 0.14)', text: '#10b981', border: 'rgba(16, 185, 129, 0.4)' },
	};
	const c = palette[tier];
	const label = t(`plan.${tier}` as never);
	return h('span', {
		className: `agy-plan-badge agy-plan-${tier}`,
		title: label,
		style: {
			...S.badgeTag!,
			background: c.bg,
			color: c.text,
			borderColor: c.border,
			fontSize: '10px',
			fontWeight: 700,
			padding: '1px 6px',
			letterSpacing: '0.02em',
			whiteSpace: 'nowrap',
		},
	}, label);
}

function renderStatusBadges(t: Translator, acc: ManagedAccount, ctx: CardHeaderCtx): unknown[] {
	const { isAuthRequired, authState } = ctx;
	const planTier = resolveAccountPlanTier(acc, ctx.accountModelIds);
	// The badge must say which KIND of problem this is: only `relogin`/`tos` mean
	// "your login is gone". `review` is a flag awaiting proof, so it is amber and
	// tells the user the plugin is re-checking instead of begging for a re-login.
	const authLabel = authState === 'tos'
		? t('status.tosBanned')
		: authState === 'validation'
			? t('status.validationRequired')
			: authState === 'review'
				? t('status.authReview')
				: t('status.authRequired');
	const authColor = authState === 'review'
		? { color: '#b45309', borderColor: '#fcd34d', bg: 'rgba(245, 158, 11, 0.14)' }
		: { color: '#ef4444', borderColor: '#fca5a5', bg: 'var(--agy-badge-email-bg)' };
	const authTitle = authState === 'review'
		? `${acc.authError || authLabel} · ${t('status.authReviewHint')}`
		: (acc.authError || authLabel);
	const actionUrl = isAuthRequired
		? (extractActionUrl(acc.authError) ?? (typeof acc.quotaUnavailable?.actionUrl === 'string' && acc.quotaUnavailable.actionUrl.startsWith('https://') ? acc.quotaUnavailable.actionUrl : undefined))
		: undefined;
	return [
		renderPlanTierBadge(t, planTier),
		acc.email ? h('span', {
			style: {
				...S.badgeTag!,
				background: 'var(--agy-badge-email-bg)',
				color: 'var(--agy-badge-email-text)',
				borderColor: 'var(--agy-badge-email-border)',
				gap: '4px',
				fontSize: '11px',
				padding: '1px 6px',
				whiteSpace: 'nowrap',
			},
			title: acc.email,
		}, uiIcon('mail', 10, 'var(--agy-badge-email-text)'), acc.email) : null,
		// Only render the dedicated-proxy pill when this account overrides the global proxy.
		acc.proxyUrl ? h('span', {
			style: {
				...S.badgeTag!,
				background: 'var(--agy-badge-proxy-bg)',
				color: 'var(--agy-badge-proxy-text)',
				borderColor: 'var(--agy-badge-proxy-border)',
				gap: '4px',
				fontSize: '10px',
				padding: '1px 5px',
			},
			title: acc.proxyUrl,
		}, uiIcon('globe', 10, 'var(--agy-badge-proxy-text)'), t('status.proxy')) : null,
		isAuthRequired ? h(actionUrl ? 'a' : 'span', {
			...(actionUrl ? { href: actionUrl, target: '_blank', rel: 'noopener noreferrer' } : {}),
			title: authTitle,
			style: {
				...S.badgeTag!,
				background: authColor.bg,
				color: authColor.color,
				borderColor: authColor.borderColor,
				gap: '3px',
				fontSize: '10px',
				padding: '1px 5px',
				fontWeight: 700,
				whiteSpace: 'nowrap',
				flexShrink: 0,
				textDecoration: actionUrl ? 'underline' : 'none',
			},
		}, uiIcon('alert', 10, authColor.color), authLabel) : null,
		!acc.enabled ? h('span', {
			style: {
				...S.badgeTag!,
				background: 'var(--agy-bg-subbox)',
				color: 'var(--agy-text-secondary)',
				borderColor: 'var(--agy-border-subbox)',
				gap: '3px',
				fontSize: '10px',
				padding: '1px 5px',
				fontWeight: 700,
			},
			title: t('status.disabled'),
		}, uiIcon('power', 10, '#64748b'), t('status.disabled')) : null,
	];
}

function renderHeaderBadges(t: Translator, acc: ManagedAccount, ctx: CardHeaderCtx): unknown {
	const { dotColor, displayAlias, isEditingAlias, setEditingAliasId } = ctx;
	return h('div', { className: 'agy-card-title-cluster', style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', minWidth: 0 } },
		h('span', {
			className: 'agy-pulse-dot',
			style: { background: dotColor, boxShadow: `0 0 6px ${dotColor}aa`, marginLeft: '1px' },
		}),
		h('span', {
			className: 'agy-card-alias',
			style: {
				fontWeight: 700,
				fontSize: '13px',
				color: 'var(--agy-text-primary)',
				whiteSpace: 'nowrap',
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				maxWidth: '100%',
				cursor: 'text',
				borderRadius: '4px',
				padding: '0 3px',
				margin: '0 -3px',
				borderBottom: isEditingAlias ? '1px dashed var(--agy-text-secondary)' : '1px dashed transparent',
			},
			title: `${t('account.renameTitle')} · ${displayAlias}`,
			// Inline rename: clicking the name itself opens the editor. No separate
			// button — the label IS the affordance.
			onClick: () => setEditingAliasId(isEditingAlias ? null : acc.id),
			onKeyDown: (e: { key?: string; preventDefault?: () => void }) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault?.();
					setEditingAliasId(isEditingAlias ? null : acc.id);
				}
			},
			role: 'button',
			tabIndex: 0,
		}, displayAlias),
	);
}

function renderMetaRow(t: Translator, acc: ManagedAccount, ctx: CardHeaderCtx): unknown {
	const badges = renderStatusBadges(t, acc, ctx).filter(Boolean);
	if (badges.length === 0) return null;
	return h('div', {
		className: 'agy-card-meta',
		style: {
			display: 'flex',
			alignItems: 'center',
			gap: '5px',
			flexWrap: 'wrap',
			minWidth: 0,
			paddingLeft: '1px',
		},
	}, ...badges);
}

function renderCardHeader(t: Translator, acc: ManagedAccount, ctx: CardHeaderCtx): unknown {
	const {
		isEditingProxy, isAuthRequired, isSyncing, pool, loadingAction, accountActionBusy, handlers, setEditingProxyId,
	} = ctx;
	return h('div', {
		className: 'agy-card-header',
		style: {
			display: 'flex',
			flexDirection: 'column',
			gap: '5px',
			userSelect: 'none',
			marginBottom: '8px',
		},
	},
		h('div', {
			className: 'agy-card-head',
			style: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: '8px',
				flexWrap: 'wrap',
			},
		},
			renderHeaderBadges(t, acc, ctx),
			renderActionButtons(t, acc, {
				isEditingProxy, isAuthRequired, isSyncing,
				pool, loadingAction, accountActionBusy, handlers, setEditingProxyId,
			}),
		),
		renderMetaRow(t, acc, ctx),
	);
}

function renderActionButtons(t: Translator, acc: ManagedAccount, ctx: {
	isEditingProxy: boolean;
	isAuthRequired: boolean;
	isSyncing: boolean;
	pool: AccountPoolData | undefined;
	loadingAction: string | null;
	accountActionBusy: (acc: ManagedAccount, action: string) => boolean;
	handlers: AccountsPanelHandlers;
	setEditingProxyId: (id: string | null) => void;
}): unknown {
	const { isEditingProxy, isAuthRequired, isSyncing, pool, loadingAction, accountActionBusy, handlers, setEditingProxyId } = ctx;
	const effectiveProxy = acc.proxyUrl || pool?.systemProxy;
	return h('div', {
		className: 'agy-card-actions',
		style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap', maxWidth: '100%', flexShrink: 0 },
	},
		h(Button, {
			variant: 'default', size: 'sm', className: 'agy-btn',
			style: { gap: '3px', fontSize: '11px', padding: '1px 6px', height: '22px', justifyContent: 'center' },
			title: t('account.syncTitle'),
			disabled: isSyncing,
			onClick: () => void handlers.refreshQuota(),
		}, ...(isSyncing ? [Spinner(), t('account.syncing')] : [uiIcon('refresh', 10), ` ${t('account.sync')}`])),
		// Re-login is ALWAYS available (not only after an auth failure): the user
		// may want to re-authenticate a healthy account, switch its Google
		// identity, or refresh a token that Google revoked server-side.
		handlers.beginReauth ? h(Button, {
			variant: isAuthRequired ? 'primary' : 'default', size: 'sm', className: 'agy-btn',
			style: { gap: '3px', fontSize: '11px', padding: '1px 6px', height: '22px' },
			title: t('account.reauthTitle'),
			disabled: accountActionBusy(acc, 'reauth'),
			onClick: () => void handlers.beginReauth!(acc),
		}, ...(loadingAction === `reauth:${acc.id}` ? [Spinner(), t('account.reauthing')] : [uiIcon('externalLink', 10, isAuthRequired ? '#ffffff' : 'var(--agy-text-secondary)'), ` ${t('account.reauth')}`])) : null,
		h(Button, {
			variant: isEditingProxy ? 'primary' : 'default', size: 'sm', className: 'agy-btn',
			style: { gap: '3px', fontSize: '11px', padding: '1px 6px', height: '22px' },
			title: effectiveProxy || t('proxy.placeholder'),
			disabled: accountActionBusy(acc, 'proxy'),
			onClick: () => setEditingProxyId(isEditingProxy ? null : acc.id),
		}, uiIcon('globe', 10), ` ${t('proxy.button')}`),
	);
}

function renderChildModels(t: Translator, childModels: readonly AccountModelDisplayItem[]): unknown {
	return h('div', {
		style: {
			marginTop: '6px',
			paddingTop: '6px',
			borderTop: '1px solid var(--agy-border-box)',
		},
	},
		h('div', { style: { color: 'var(--agy-text-secondary)', marginBottom: '6px', fontWeight: 600, fontSize: '11px' } }, `${t('account.models')} (${childModels.length})`),
		childModels.map((model) => {
			const hasPct = typeof model.remainingFraction === 'number';
			const pct = hasPct ? Math.round((model.remainingFraction ?? 0) * 100) : null;
			const w = formatQuotaWindow(t, model.resetTime);
			const pColor = pct === null ? 'var(--agy-text-secondary)' : pct <= 20 ? 'var(--agy-quota-low-text)' : pct <= 50 ? 'var(--agy-quota-med-text)' : 'var(--agy-quota-high-text)';
			const effortTag = model.efforts.length > 0 ? model.efforts.map(effortLabel).join('/') : '';
			return h('div', { key: `${model.family}-${model.id}`, className: 'agy-submodel-row' },
				h('div', { key: 'left', style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flexWrap: 'wrap', flex: '1 1 140px' } },
					h('span', { key: 'label', style: { fontWeight: 500, color: 'var(--agy-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }, title: `[${model.familyLabel}] ${model.name}` }, `[${model.familyLabel}] ${model.name}`),
					effortTag ? h('span', { key: 'efforts', style: { color: 'var(--agy-text-tertiary)', fontSize: '10px' } }, effortTag) : null,
				),
				h('div', { key: 'right', style: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 } },
					pct !== null ? h('span', { key: 'pct', style: { color: pColor, fontWeight: 700 } }, `${pct}%`) : null,
					w.resetText ? h('span', { key: 'reset', style: { color: 'var(--agy-text-tertiary)', fontSize: '10.5px' } }, `↻ ${w.resetText}`) : null,
				),
			);
		}),
	);
}

function renderAliasEditor(
	t: Translator,
	acc: ManagedAccount,
	aliasInputs: Record<string, string>,
	setAliasInputs: (next: Record<string, string>) => void,
	setEditingAliasId: (id: string | null) => void,
	displayAlias: string,
	loadingAction: string | null,
	accountActionBusy: (acc: ManagedAccount, action: string) => boolean,
	handlers: AccountsPanelHandlers,
): unknown {
	return renderInlineEditor(t, {
		key: 'alias-body',
		value: aliasInputs[acc.id] ?? displayAlias,
		placeholder: t('account.renamePlaceholder'),
		ariaLabel: t('aria.aliasInput'),
		saveLabel: t('proxy.save'),
		cancelLabel: t('cancel'),
		busy: accountActionBusy(acc, 'alias'),
		onChange: (next) => setAliasInputs({ ...aliasInputs, [acc.id]: next }),
		onSave: () => void handlers.saveAlias(acc.id),
		onCancel: () => setEditingAliasId(null),
	});
}

function renderProxyEditor(
	t: Translator,
	acc: ManagedAccount,
	pool: AccountPoolData | undefined,
	proxyInputs: Record<string, string>,
	setProxyInputs: (next: Record<string, string>) => void,
	setEditingProxyId: (id: string | null) => void,
	loadingAction: string | null,
	accountActionBusy: (acc: ManagedAccount, action: string) => boolean,
	handlers: AccountsPanelHandlers,
): unknown {
	return renderInlineEditor(t, {
		key: 'proxy-body',
		value: proxyInputs[acc.id] ?? acc.proxyUrl ?? '',
		placeholder: pool?.systemProxy ? `${t('proxy.placeholder')} (${pool.systemProxy})` : t('proxy.placeholder'),
		ariaLabel: t('aria.proxyInput'),
		saveLabel: t('proxy.save'),
		cancelLabel: t('cancel'),
		busy: accountActionBusy(acc, 'proxy'),
		onChange: (next) => setProxyInputs({ ...proxyInputs, [acc.id]: next }),
		onSave: () => void handlers.saveProxy(acc.id),
		onCancel: () => setEditingProxyId(null),
	});
}
