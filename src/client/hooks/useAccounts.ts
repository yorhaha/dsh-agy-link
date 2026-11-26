// Single-account action handlers. All writes go through `/account/*`; busy
// state stays per-action so one action never disables every control on the
// panel (see test/busy-scoping.test.ts).
//
// The account is the system `agy` sign-in, so there is nothing to add, remove,
// reorder, enable/disable or pin: what remains is quota refresh, cooldown
// reset, and the two labels that describe that one credential (alias, proxy).

import { postAccount } from '../api.ts';
import type { QuotaFamily } from '../../common/quota-bench.ts';
import type { ShowToast } from '../ui/Toast.ts';
import type { Translator } from './useTranslation.ts';

export interface AccountActionsDeps {
	refresh: () => Promise<void>;
	showToast: ShowToast;
	setLoadingAction: (value: string | null) => void;
	t: Translator;
	proxyInputs: Record<string, string>;
	setEditingProxyId: (id: string | null) => void;
	aliasInputs: Record<string, string>;
	setEditingAliasId: (id: string | null) => void;
}

export interface AccountActions {
	refreshQuota: () => Promise<void>;
	saveProxy: (id: string) => Promise<void>;
	saveAlias: (id: string) => Promise<void>;
	clearCooldown: (id?: string, family?: QuotaFamily) => Promise<void>;
}

export function useAccounts(deps: AccountActionsDeps): AccountActions {
	const actionFailed = (): void => {
		deps.showToast(deps.t('api.genericError'), 'error');
	};
	return {
		...quotaActions(deps, actionFailed),
		...labelActions(deps, actionFailed),
	};
}

function quotaActions(
	deps: AccountActionsDeps,
	actionFailed: () => void,
): Pick<AccountActions, 'refreshQuota' | 'clearCooldown'> {
	const { refresh, showToast, setLoadingAction, t } = deps;

	const refreshQuota = async (): Promise<void> => {
		setLoadingAction('refresh:all');
		try {
			const res = await postAccount('refresh-quota', {});
			if (res === null || res?.ok === false) {
				actionFailed();
				return;
			}
			await refresh();
			// The host answers `alreadyRunning` when a refresh was still in flight.
			// Saying "已开始刷新" then was a lie: the click did nothing for up to
			// QUOTA_REFRESH_DEDUP_MS, which is why a slow refresh looked stuck.
			if (res?.alreadyRunning === true) {
				showToast(t('quota.refreshInProgress'), 'info');
				return;
			}
			// The host answers immediately and refreshes in the background; the
			// 3s status poll delivers the new numbers. Saying "refreshed" here
			// used to be a lie (and the old blocking request left the spinner
			// spinning for the whole network cascade).
			showToast(res?.pending === true ? t('quota.refreshStarted') : t('quota.refreshed'), res?.pending === true ? 'info' : 'success');
		} finally {
			setLoadingAction(null);
		}
	};

	const clearCooldown = async (id?: string, family?: QuotaFamily): Promise<void> => {
		setLoadingAction(`clearCooldown:${id ?? 'all'}:${family ?? 'all'}`);
		const res = await postAccount('clear-cooldown', family ? { family } : {});
		if (res === null || res?.ok === false) {
			setLoadingAction(null);
			actionFailed();
			return;
		}
		await refresh();
		setLoadingAction(null);
		showToast(t('account.clearCooldownDone'), 'success');
	};

	return { refreshQuota, clearCooldown };
}

function labelActions(
	deps: AccountActionsDeps,
	actionFailed: () => void,
): Pick<AccountActions, 'saveProxy' | 'saveAlias'> {
	const { refresh, showToast, setLoadingAction, t, proxyInputs, setEditingProxyId, aliasInputs, setEditingAliasId } = deps;

	const saveProxy = async (id: string): Promise<void> => {
		setLoadingAction(`proxy:${id}`);
		const proxyUrl = (proxyInputs[id] ?? '').trim();
		const res = await postAccount('proxy', { proxyUrl });
		if (res === null || res?.ok === false) {
			setLoadingAction(null);
			actionFailed();
			return;
		}
		setEditingProxyId(null);
		await refresh();
		setLoadingAction(null);
		showToast(t('proxy.saved'), 'success');
	};

	const saveAlias = async (id: string): Promise<void> => {
		const alias = (aliasInputs[id] ?? '').trim();
		if (alias === '') {
			// An empty label would leave the card nameless; keep the editor open.
			showToast(t('account.renameEmpty'), 'error');
			return;
		}
		setLoadingAction(`alias:${id}`);
		try {
			const res = await postAccount('alias', { alias });
			if (res === null || res?.ok === false) {
				actionFailed();
				return;
			}
			await refresh();
			setEditingAliasId(null);
			showToast(t('account.renamed'), 'success');
		} finally {
			setLoadingAction(null);
		}
	};

	return { saveProxy, saveAlias };
}
