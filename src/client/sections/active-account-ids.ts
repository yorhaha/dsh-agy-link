// Which account the console should treat as "in use".
//
// The plugin drives exactly ONE account (the system HOME sign-in), so there is
// nothing to pin, rotate or predict: the primary account answers for every
// model family, and the panel only needs it to colour the family bar.
import type { AccountPoolData } from '../../common/pool-types.ts';
import { QUOTA_FAMILIES, type QuotaFamily } from '../../common/quota-bench.ts';

/** The one account this plugin serves with: the primary, else the only stored row. */
export function resolveFamilyActiveIds(pool: AccountPoolData | undefined): Partial<Record<QuotaFamily, string>> {
	const primary = pool?.primaryAccountId ?? pool?.accounts[0]?.id;
	const out: Partial<Record<QuotaFamily, string>> = {};
	for (const fam of QUOTA_FAMILIES) out[fam] = primary;
	return out;
}
