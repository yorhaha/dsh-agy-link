// Which account the console should treat as "in use" for each model family.
//
// The pool now holds exactly ONE account (the system HOME sign-in), so there is
// nothing to pin or rotate: the primary account is the answer for every family.
// The two exported names are kept because AccountsPanel still distinguishes an
// "in use" card from a merely eligible one; both now resolve to that account.
import type { AccountPoolData } from '../../common/pool-types.ts';
import { QUOTA_FAMILIES, type QuotaFamily } from '../../common/quota-bench.ts';

type OptimisticByFamily = Partial<Record<QuotaFamily, string>> | undefined;
type OptimisticId = string | null | undefined;

/** The one account this pool serves with: the primary, else the only stored row. */
function primaryAccountId(pool: AccountPoolData | undefined): string | undefined {
	return pool?.primaryAccountId ?? pool?.accounts[0]?.id;
}

export function resolveFamilyActiveIds(
	pool: AccountPoolData | undefined,
	optimisticActiveByFamily: OptimisticByFamily,
	optimisticActiveId: OptimisticId,
): Partial<Record<QuotaFamily, string>> {
	const out: Partial<Record<QuotaFamily, string>> = {};
	const primary = primaryAccountId(pool);
	for (const fam of QUOTA_FAMILIES) {
		out[fam] =
			optimisticActiveByFamily?.[fam] ??
			(fam === 'google' ? optimisticActiveId ?? undefined : undefined) ??
			primary;
	}
	return out;
}

export function resolveFamilyPinnedIds(
	pool: AccountPoolData | undefined,
	optimisticActiveByFamily: OptimisticByFamily,
	optimisticActiveId: OptimisticId,
): Partial<Record<QuotaFamily, string>> {
	return resolveFamilyActiveIds(pool, optimisticActiveByFamily, optimisticActiveId);
}
