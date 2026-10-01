// ============================================================================
// PassFiller 门面（上游代码树唯一引用的 PassFiller 模块）
//
// 上游仅有的两处改动之一（messageRouter.ts 补丁）把 getMatchingAccounts /
// getDecryptedEntryById 两个名字的 import 从 './passwordCache' 改道到
// '@/passfiller'（本文件），调用点零改动，自动走下方包装实现。
//
// 包装语义（与原 fork 提交 ffd335d 语义等价）：
//   - getMatchingAccounts：本地 vault 与 MCP 外部源并行查询后合并；
//     本地锁定但 MCP 有货时仍单独供数（locked: false），无货透传锁定响应
//   - getDecryptedEntryById：mcp: 前缀条目委托 MCP 服务端 get_entry 解密，
//     其余透传本地 vault
//
// 将来若需包装更多 passwordCache 导出（如支持 MCP TOTP 时包装
// getInlineTotpCode），在此追加包装函数、补丁中多改道一个名字即可，
// 上游敞口结构不变。
// ============================================================================

import {
  getMatchingAccounts as getMatchingAccountsFromVault,
  getDecryptedEntryById as getDecryptedEntryByIdFromVault,
} from '@/entrypoints/background/passwordCache';
import type { MatchingAccountsResponse } from '@/utils/types';
import { isMcpId, queryExternalAccounts, resolveExternalEntry } from './mcpSource';

/**
 * 包装 getMatchingAccounts：本地 vault 匹配结果 + MCP 外部条目合并
 *
 * - 并行查询：本地 vault 与 MCP 互不阻断（MCP 未启用时 metas 恒空、近乎零开销）
 * - 本地锁定：MCP 有货时单独供数（域名匹配/关键词过滤均在服务端完成），
 *   无货时透传本地锁定响应（保留 noMasterPassword 等引导字段）
 * - 本地正常：MCP 条目追加于本地条目之后；crossDomainCount 透传
 *   （该计数描述本地跨子域提示，与 MCP 条目无关）
 * - totalMatched：本地命中数（截断前口径）+ MCP 条数
 */
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

/**
 * 包装 getDecryptedEntryById：mcp: 前缀条目委托 MCP 服务端 get_entry 取明文
 *
 * 不依赖本地会话（用户可能只配置 MCP 外部源、不设置本地 vault）；
 * 服务端锁定 / 条目不存在 / 连接失败均返回 null，
 * 由上游调用方按「会话已锁定或不存在」处理。
 */
export async function getDecryptedEntryById(
  ...args: Parameters<typeof getDecryptedEntryByIdFromVault>
): ReturnType<typeof getDecryptedEntryByIdFromVault> {
  const [id] = args;
  if (isMcpId(id)) return resolveExternalEntry(id);
  return getDecryptedEntryByIdFromVault(...args);
}
