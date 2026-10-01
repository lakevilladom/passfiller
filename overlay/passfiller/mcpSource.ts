// ============================================================================
// MCP 凭据源 · 薄适配器（规范与接口的「扩展侧」实现）
//
// 通用设计：任何实现了下方线协议的 MCP HTTP 服务均可作为外部凭据源。
//
// 分工（最小侵入架构）：
//   - 本模块只做三件事：配置读写、MCP JSON-RPC 调用、结果映射为扩展内部类型。
//     无明文缓存、无业务逻辑（域名匹配 / 关键词过滤 / 解密 / 锁定语义全部在
//     服务端实现，见协议注释）。
//   - 唯一被门面（passfiller/index.ts）消费的接口（上游 messageRouter.ts 经
//     import 改道间接使用；设置页 passfiller-options 直接读写配置）：
//       queryExternalAccounts(domain, keyword?)  → 内联下拉元数据（绝不含密码）
//       resolveExternalEntry(id)                 → FILL_BY_ID 按条目取明文（调服务端 get_entry）
//       isMcpId(id)                              → id 命名空间路由
//
// 线协议（规范，服务端须实现同名工具；实际工具名 = `<前缀>_` + 工具名，前缀可配）：
//   query_password { domain, keyword? }
//     → { locked: true } | { found: false }
//     | { found: true, entries: [{ id, title, username, url }] }   ← 不含 password
//   get_entry { id }
//     → { locked: true } | { found: false }
//     | { found: true, entry: { id, title, username, password, url, totp? } }
//
// 安全边界：
//   - API Key 存于 chrome.storage.local（本机、页面不可达）；调用走 Bearer；
//   - query 响应不携带任何密码——明文仅在用户显式点击填充的那一次经 get_entry 下发；
//   - 本模块零状态：MV3 Service Worker 随时被杀重启不影响填充链路。
// ============================================================================

import { logger } from '@/utils/logger';
import { fetchFaviconDataUrl } from '@/utils/favicon';
import type { MatchingAccountMeta, PasswordEntry } from '@/utils/types';

/** MCP 条目 id 前缀：与本地 vault 条目 id 命名空间隔离，getDecryptedEntryById 据此路由 */
export const MCP_SOURCE_PREFIX = 'mcp:';

/** chrome.storage.local 中的配置键 */
export const MCP_CONFIG_STORAGE_KEY = 'mcp_source_config';

export interface McpSourceConfig {
  /** 是否启用 MCP 凭据源（默认关闭，避免无谓的网络探测） */
  enabled: boolean;
  /** MCP 服务端点（协议 + host + port + 路径，如 https://mcp.example.com/mcp） */
  endpoint: string;
  /** 服务端签发的 API Key */
  apiKey: string;
  /** 工具名前缀：实际调用 `<前缀>_query_password` / `<前缀>_get_entry`；空串 = 用工具原名 */
  toolPrefix: string;
}

const DEFAULT_CONFIG: McpSourceConfig = {
  enabled: false,
  endpoint: '',
  apiKey: '',
  toolPrefix: '',
};

/** 读取 MCP 配置（与默认值合并，缺字段时用默认） */
export async function getMcpConfig(): Promise<McpSourceConfig> {
  const result = await chrome.storage.local.get(MCP_CONFIG_STORAGE_KEY);
  const stored = (result[MCP_CONFIG_STORAGE_KEY] as Partial<McpSourceConfig> | undefined) ?? {};
  return { ...DEFAULT_CONFIG, ...stored };
}

/** 写入 MCP 配置（与现有配置浅合并） */
export async function setMcpConfig(patch: Partial<McpSourceConfig>): Promise<void> {
  const current = await getMcpConfig();
  await chrome.storage.local.set({ [MCP_CONFIG_STORAGE_KEY]: { ...current, ...patch } });
}

/**
 * 判断 endpoint 是否落在回环（127.0.0.1 / localhost）。
 * 回环不在 <all_urls> 覆盖范围，需经 optional_host_permissions 现场申请；
 * 远程端点由 <all_urls> 覆盖，无需申请。
 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

/**
 * 为本机 MCP endpoint 现场申请回环权限（必须在用户手势中调用，如弹窗按钮点击）。
 * request 幂等：已授权时立即返回 true、无弹窗；用户拒绝或关闭返回 false。
 * 远程 endpoint 直接放行。
 */
export async function ensureMcpPermission(endpoint: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isLoopbackEndpoint(endpoint)) return { ok: true };
  const origin = `http://${new URL(endpoint).hostname}/*`;
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) return { ok: false, message: '未授予回环权限（已取消或关闭）' };
    return { ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `申请回环权限失败：${msg}` };
  }
}

/** 判断 id 是否来自 MCP 外部源 */
export function isMcpId(id: string): boolean {
  return id.startsWith(MCP_SOURCE_PREFIX);
}

/**
 * 解析「MCP 服务地址」粘贴内容（https://mcp.example.com/mcp?key=xxx）
 * @returns 解析出的 endpoint / apiKey；格式无效或缺 key 时返回 null
 */
export function parseMcpUrl(input: string): { endpoint: string; apiKey: string } | null {
  try {
    const url = new URL(input.trim());
    const apiKey = url.searchParams.get('key') ?? '';
    if (!/^https?:$/.test(url.protocol) || !apiKey) return null;
    url.search = ''; // key 不进 endpoint（经 Bearer 头携带）
    const path = url.pathname === '/' ? '/mcp' : url.pathname;
    return { endpoint: `${url.origin}${path}`, apiKey };
  } catch {
    return null;
  }
}

// ==================== MCP JSON-RPC 底层调用 ====================

type McpContent = Record<string, unknown>;
type McpCallResult = { ok: true; content: McpContent } | { ok: false; message: string };

/**
 * 调用一个 MCP 工具（tools/call），统一处理网络层 / HTTP / 框架层错误与
 * structuredContent / text 两种响应形态。绝不抛出。
 */
async function callMcpTool(cfg: McpSourceConfig, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
  const toolName = cfg.toolPrefix ? `${cfg.toolPrefix}_${tool}` : tool;
  let response: Response;
  try {
    // 10s 超时：挂死的服务端不能拖住内联下拉（Chrome 103+ 支持 AbortSignal.timeout）
    response = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // 网络层失败：服务未运行 / 端口不通 / 防火墙拦截
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `无法连接 MCP 服务（${msg}）` };
  }

  if (!response.ok) return { ok: false, message: `MCP 服务返回 HTTP ${response.status}` };

  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json) return { ok: false, message: 'MCP 服务响应解析失败' };

  // 框架层错误（-32602 未找到工具：服务端插件未安装/被禁用；-32000 未能就绪 等）
  const errObj = json.error as McpContent | undefined;
  if (errObj) return { ok: false, message: String(errObj.message ?? 'MCP 框架错误') };

  const result = json.result as McpContent | undefined;
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return { ok: true, content: result.structuredContent as McpContent };
  }
  // 兼容仅返回 text 的实现
  const content = result?.content as Array<{ text?: string }> | undefined;
  if (Array.isArray(content) && typeof content[0]?.text === 'string') {
    try {
      const parsed = JSON.parse(content[0].text as string);
      if (parsed && typeof parsed === 'object') return { ok: true, content: parsed as McpContent };
    } catch {
      // 落入下方「缺少有效内容」
    }
  }
  return { ok: false, message: 'MCP 服务响应缺少有效内容' };
}

// ==================== 供门面（passfiller/index.ts）消费的接缝 ====================

export interface ExternalAccountsResult {
  /** 已映射为 MatchingAccountMeta 的 MCP 条目（id 带 mcp: 前缀，绝不含密码） */
  metas: MatchingAccountMeta[];
  /** MCP 源是否启用（false = 未启用/读取失败；启用但锁定/出错/无匹配均为 true，非阻断） */
  available: boolean;
}

/**
 * 按域名（+可选关键词）查询服务端 query_password，映射为内联下拉元数据。
 *
 * 关键词过滤在服务端完成（协议参数 keyword），本模块不做二次过滤；
 * 所有失败路径（连接错/锁定/无匹配）一律返回空 metas 且不抛出，本地 vault 流程照常。
 */
export async function queryExternalAccounts(domain: string, keyword?: string): Promise<ExternalAccountsResult> {
  const cfg = await getMcpConfig().catch(() => null);
  if (!cfg || !cfg.enabled) return { metas: [], available: false };

  const args: Record<string, unknown> = { domain };
  if (keyword) args.keyword = keyword;

  const res = await callMcpTool(cfg, 'query_password', args);
  if (!res.ok) {
    logger.warn('[mcpSource] query_password:', res.message);
    return { metas: [], available: true };
  }

  const c = res.content;
  if (c.locked === true || c.found === false) return { metas: [], available: true };

  const raw = Array.isArray(c.entries) ? (c.entries as Array<Record<string, unknown>>) : [];
  const metas: MatchingAccountMeta[] = await Promise.all(
    raw
      .filter(e => !!e && typeof e.id === 'string')
      .map(async e => ({
        id: MCP_SOURCE_PREFIX + String(e.id),
        username: typeof e.username === 'string' ? e.username : '',
        tag: typeof e.title === 'string' ? e.title : '',
        remark: '',
        url: typeof e.url === 'string' ? e.url : '',
        favorite: false,
        hasTotp: false,
        favicon: e.url ? await fetchFaviconDataUrl(String(e.url), 32) : '',
        tier: 0,
      })),
  );
  return { metas, available: true };
}

/**
 * FILL_BY_ID 接缝：按 `mcp:<id>` 调服务端 get_entry 取单条明文。
 *
 * 不依赖本地会话（用户可能只用外部源、不配置本地 vault）；
 * 服务端锁定 / 条目不存在 / 连接失败均返回 null，由调用方按「会话已锁定或不存在」处理。
 */
export async function resolveExternalEntry(fullId: string): Promise<PasswordEntry | null> {
  const cfg = await getMcpConfig().catch(() => null);
  if (!cfg?.enabled) return null;

  const res = await callMcpTool(cfg, 'get_entry', { id: fullId.slice(MCP_SOURCE_PREFIX.length) });
  if (!res.ok) {
    logger.warn('[mcpSource] get_entry:', res.message);
    return null;
  }

  const c = res.content;
  if (c.locked === true || c.found === false) return null;

  const e = c.entry as Record<string, unknown> | undefined;
  if (!e || typeof e.username !== 'string') return null;
  return {
    id: fullId,
    username: e.username,
    password: typeof e.password === 'string' ? e.password : '',
    url: typeof e.url === 'string' ? e.url : '',
    tag: typeof e.title === 'string' ? e.title : '',
    remark: '',
    totp: typeof e.totp === 'string' ? e.totp : '',
    createTime: 0,
    updateTime: 0,
    favorite: false,
    order: 0,
  };
}

// ==================== 配置测试（供 passfiller-options 设置页） ====================

export type McpTestStatus = { kind: 'ok' } | { kind: 'locked' } | { kind: 'error'; message: string };

/**
 * 用（可能尚未保存的）配置测试连通性：哨兵域名落在 found/notFound 均代表
 * 「服务可达且已解锁」；locked = 可达未解锁；error = 连不通（未运行/端口/密钥）。
 */
export async function testMcpConfig(cfg: McpSourceConfig): Promise<McpTestStatus> {
  const res = await callMcpTool(cfg, 'query_password', { domain: '__connection_test__' });
  if (!res.ok) return { kind: 'error', message: res.message };
  if (res.content.locked === true) return { kind: 'locked' };
  return { kind: 'ok' };
}
