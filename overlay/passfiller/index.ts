// PassFiller 门面：上游唯一 import 点（messageRouter.ts 补丁把两个名字改道至此）。
// 包装 passwordCache 的导出，本地 vault 与 MCP 外部源合并呈现。

import {
  getMatchingAccounts as getMatchingAccountsFromVault,
  getDecryptedEntryById as getDecryptedEntryByIdFromVault,
} from '@/entrypoints/background/passwordCache';
import type { MatchingAccountsResponse } from '@/utils/types';
import { isMcpId, queryExternalAccounts, resolveExternalEntry } from './mcpSource';

// 包装 getMatchingAccounts：本地 vault + MCP 外部条目合并呈现。
// 并行查询互不阻断；本地锁定时 MCP 有货仍单独供数；totalMatched 含 MCP 条数。
export async function getMatchingAccounts(
  ...args: Parameters<typeof getMatchingAccountsFromVault>
): Promise<MatchingAccountsResponse> {
  const [domain, port, keyword] = args;

  const [local, ext] = await Promise.all([
    getMatchingAccountsFromVault(domain, port, keyword),
    queryExternalAccounts(domain, keyword),
  ]);

  if (local.locked) {
    return ext.metas.length ? { locked: false, accounts: ext.metas, totalMatched: ext.metas.length } : local;
  }

  return {
    ...local,
    accounts: [...local.accounts, ...ext.metas],
    totalMatched: (local.totalMatched ?? local.accounts.length) + ext.metas.length,
  };
}

// 包装 getDecryptedEntryById：mcp: 前缀条目委托 MCP 服务端 get_entry 取明文；
// 其余透传本地 vault。服务端锁定/不存在/失败返回 null。
export async function getDecryptedEntryById(
  ...args: Parameters<typeof getDecryptedEntryByIdFromVault>
): ReturnType<typeof getDecryptedEntryByIdFromVault> {
  const [id] = args;
  if (isMcpId(id)) return resolveExternalEntry(id);
  return getDecryptedEntryByIdFromVault(...args);
}
