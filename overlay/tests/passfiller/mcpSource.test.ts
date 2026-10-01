// ============================================================================
// PassFiller MCP 凭据源协议解析单测（自包含 mock，不依赖上游测试基建）
// 覆盖：parseMcpUrl / isMcpId / isLoopbackEndpoint / callMcpTool 响应映射
// （经 queryExternalAccounts / resolveExternalEntry 间接测，callMcpTool 为私有）
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MCP_SOURCE_PREFIX,
  getMcpConfig,
  setMcpConfig,
  isMcpId,
  isLoopbackEndpoint,
  parseMcpUrl,
  queryExternalAccounts,
  resolveExternalEntry,
  type McpSourceConfig,
} from '@/passfiller/mcpSource';

const ENDPOINT = 'https://mcp.example.com/mcp';

// ---------- chrome.storage.local 内存 mock ----------

const storage = new Map<string, unknown>();

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: storage.get(key) }),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) storage.set(k, v);
      },
    },
  },
  permissions: { request: async () => true, contains: async () => true },
});

// ---------- fetch mock：仅拦截 ENDPOINT，其余（favicon 等）返回空 ----------

let mcpResponse: { status: number; body: unknown } | null = null;
let lastFetchBody: Record<string, unknown> | null = null;

vi.stubGlobal(
  'fetch',
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== ENDPOINT) return new Response('', { status: 404 });
    lastFetchBody = init?.body ? JSON.parse(String(init.body)) : null;
    if (!mcpResponse) return new Response('', { status: 404 });
    return new Response(JSON.stringify(mcpResponse.body), { status: mcpResponse.status });
  }),
);

async function setConfig(patch: Partial<McpSourceConfig>) {
  await setMcpConfig({ endpoint: ENDPOINT, apiKey: 'k', toolPrefix: '', ...patch });
}

beforeEach(() => {
  storage.clear();
  mcpResponse = null;
  lastFetchBody = null;
  vi.mocked(fetch).mockClear();
});

// ---------- parseMcpUrl ----------

describe('parseMcpUrl', () => {
  it('解析合法地址并从 endpoint 剥离 key', () => {
    expect(parseMcpUrl('https://mcp.example.com/mcp?key=abc')).toEqual({
      endpoint: 'https://mcp.example.com/mcp',
      apiKey: 'abc',
    });
  });

  it('根路径补 /mcp', () => {
    expect(parseMcpUrl('https://mcp.example.com/?key=k')).toEqual({
      endpoint: 'https://mcp.example.com/mcp',
      apiKey: 'k',
    });
  });

  it('缺失 key 返回 null', () => {
    expect(parseMcpUrl('https://mcp.example.com/mcp')).toBeNull();
  });

  it('非 http(s) 协议返回 null', () => {
    expect(parseMcpUrl('ftp://mcp.example.com/mcp?key=k')).toBeNull();
  });

  it('非法输入返回 null', () => {
    expect(parseMcpUrl('not a url')).toBeNull();
    expect(parseMcpUrl('')).toBeNull();
  });
});

// ---------- isMcpId / isLoopbackEndpoint ----------

describe('isMcpId', () => {
  it('mcp: 前缀路由', () => {
    expect(isMcpId(`${MCP_SOURCE_PREFIX}42`)).toBe(true);
    expect(isMcpId('local-entry')).toBe(false);
  });
});

describe('isLoopbackEndpoint', () => {
  it('127.0.0.1 与 localhost 为回环', () => {
    expect(isLoopbackEndpoint('http://127.0.0.1:8765/mcp')).toBe(true);
    expect(isLoopbackEndpoint('http://localhost:8765/mcp')).toBe(true);
  });

  it('远程端点与无效输入非回环', () => {
    expect(isLoopbackEndpoint('https://mcp.example.com/mcp')).toBe(false);
    expect(isLoopbackEndpoint('not a url')).toBe(false);
  });
});

// ---------- callMcpTool 响应映射（经公开接缝间接测） ----------

describe('queryExternalAccounts', () => {
  it('未启用时 available=false 且不发请求', async () => {
    const r = await queryExternalAccounts('github.com');
    expect(r).toEqual({ metas: [], available: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('structuredContent 形态：条目映射为元数据（id 加前缀、绝无密码字段）', async () => {
    await setConfig({ enabled: true });
    mcpResponse = {
      status: 200,
      body: {
        result: {
          structuredContent: {
            found: true,
            entries: [{ id: 'e1', title: 'GH', username: 'u1', url: '' }],
          },
        },
      },
    };
    const r = await queryExternalAccounts('github.com', 'git');
    expect(r.available).toBe(true);
    expect(r.metas).toHaveLength(1);
    expect(r.metas[0]).toMatchObject({
      id: `${MCP_SOURCE_PREFIX}e1`,
      username: 'u1',
      tag: 'GH',
      hasTotp: false,
      tier: 0,
    });
    // 请求体：domain + keyword + Bearer 鉴权头
    expect(lastFetchBody?.params).toMatchObject({
      name: 'query_password',
      arguments: { domain: 'github.com', keyword: 'git' },
    });
  });

  it('text 形态兼容：content[0].text 内嵌 JSON', async () => {
    await setConfig({ enabled: true });
    mcpResponse = {
      status: 200,
      body: {
        result: {
          content: [{ text: JSON.stringify({ found: true, entries: [{ id: 'x', username: 'y' }] }) }],
        },
      },
    };
    const r = await queryExternalAccounts('a.com');
    expect(r.available).toBe(true);
    expect(r.metas[0]?.id).toBe(`${MCP_SOURCE_PREFIX}x`);
  });

  it('toolPrefix 生效：实际工具名加前缀', async () => {
    await setConfig({ enabled: true, toolPrefix: 'pf' });
    mcpResponse = { status: 200, body: { result: { structuredContent: { found: false } } } };
    await queryExternalAccounts('a.com');
    expect(lastFetchBody?.params).toMatchObject({ name: 'pf_query_password' });
  });

  it('服务端锁定：metas 空、available=true（非阻断）', async () => {
    await setConfig({ enabled: true });
    mcpResponse = { status: 200, body: { result: { structuredContent: { locked: true } } } };
    expect(await queryExternalAccounts('a.com')).toEqual({ metas: [], available: true });
  });

  it('HTTP 500：失败不抛出、不阻断本地 vault 流程', async () => {
    await setConfig({ enabled: true });
    mcpResponse = { status: 500, body: {} };
    expect(await queryExternalAccounts('a.com')).toEqual({ metas: [], available: true });
  });
});

describe('resolveExternalEntry', () => {
  it('按条目取回明文（id 保留完整 mcp: 前缀）', async () => {
    await setConfig({ enabled: true });
    mcpResponse = {
      status: 200,
      body: {
        result: {
          structuredContent: {
            found: true,
            entry: { id: 'e1', username: 'u1', password: 'p1', url: 'https://a.com' },
          },
        },
      },
    };
    const entry = await resolveExternalEntry(`${MCP_SOURCE_PREFIX}e1`);
    expect(entry).toMatchObject({
      id: `${MCP_SOURCE_PREFIX}e1`,
      username: 'u1',
      password: 'p1',
      url: 'https://a.com',
    });
    // get_entry 参数为剥离前缀后的裸 id
    expect(lastFetchBody?.params).toMatchObject({
      name: 'get_entry',
      arguments: { id: 'e1' },
    });
  });

  it('服务端锁定返回 null', async () => {
    await setConfig({ enabled: true });
    mcpResponse = { status: 200, body: { result: { structuredContent: { locked: true } } } };
    expect(await resolveExternalEntry(`${MCP_SOURCE_PREFIX}e1`)).toBeNull();
  });

  it('未启用返回 null', async () => {
    await setConfig({ enabled: false });
    expect(await resolveExternalEntry(`${MCP_SOURCE_PREFIX}e1`)).toBeNull();
  });
});

// ---------- 配置读写 ----------

describe('getMcpConfig / setMcpConfig', () => {
  it('浅合并：缺省字段回退默认值', async () => {
    await setConfig({ enabled: true });
    const cfg = await getMcpConfig();
    expect(cfg).toMatchObject({ enabled: true, endpoint: ENDPOINT, apiKey: 'k', toolPrefix: '' });
    await setMcpConfig({ toolPrefix: 'pf' });
    expect((await getMcpConfig()).toolPrefix).toBe('pf');
    expect((await getMcpConfig()).enabled).toBe(true);
  });
});
