#!/usr/bin/env node
// postprocess.js — 构建后处理（wxt build 之后）：注入版本/改名/update_url/回环权限。幂等。

import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: path.join('.output', 'chrome-mv3') },
    version: { type: 'string' },
    'update-url': { type: 'string' },
  },
});

if (!values.version || !/^\d+(\.\d+){0,3}$/.test(values.version)) {
  console.error('用法: node scripts/postprocess.js --out <.output/chrome-mv3> --version <x.y.z.n> [--update-url <updates.xml 地址>]');
  process.exit(2);
}

const outDir = path.resolve(values.out);
const manifestPath = path.join(outDir, 'manifest.json');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));


const loopbackOrigins = ['http://127.0.0.1/*', 'http://localhost/*'];
const hostPerms = manifest.host_permissions ?? [];
const allUrlsCovered = hostPerms.includes('<all_urls>');
if (allUrlsCovered) {
  console.log('[post] 回环端点已被 <all_urls> 覆盖，跳过 optional_host_permissions 注入（避免冗余告警）');
} else {
  const existing = new Set(manifest.optional_host_permissions ?? []);
  for (const origin of loopbackOrigins) existing.add(origin);
  manifest.optional_host_permissions = [...existing];
}

// 版本号：{上游版本}.{pf 迭代}
manifest.version = values.version;

// 工具栏标题
if (manifest.action?.default_title) manifest.action.default_title = 'PassFiller';

// 自托管更新地址（crx/企业策略场景；unpacked 无效但无害）
// parseArgs 不做 kebab→camel，须用 values['update-url'] 取值
const updateUrl = values['update-url'];
if (updateUrl) manifest.update_url = updateUrl;

await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(
  `[post] manifest: version=${manifest.version}, optional_host_permissions=${(manifest.optional_host_permissions ?? []).join(', ') || '(无)'}` +
    (updateUrl ? `, update_url=${updateUrl}` : ''),
);

// 显示名与描述（manifest.name 是 __MSG_extensionName__，落在 _locales）
const LOCALE_TEXT = {
  zh_CN: {
    extensionName: 'PassFiller',
    extensionDescription: '账号密码管理助手 + PassFiller：本地加密密码管理器，并支持 MCP 外部凭据源（内联下拉合并展示、按条目委托解密）。',
  },
  en: {
    extensionName: 'PassFiller',
    extensionDescription:
      'Account Password Helper + PassFiller: local encrypted password manager with an MCP external credential source (merged inline dropdown, per-entry delegated decryption).',
  },
};

for (const [locale, text] of Object.entries(LOCALE_TEXT)) {
  const messagesPath = path.join(outDir, '_locales', locale, 'messages.json');
  let messages;
  try {
    messages = JSON.parse(await readFile(messagesPath, 'utf8'));
  } catch {
    console.warn(`[post] 缺少 ${locale} 的 messages.json，跳过`);
    continue;
  }
  if (messages.extensionName) messages.extensionName.message = text.extensionName;
  if (messages.extensionDescription) messages.extensionDescription.message = text.extensionDescription;
  await writeFile(messagesPath, JSON.stringify(messages, null, 2) + '\n', 'utf8');
  console.log(`[post] _locales/${locale}: extensionName → PassFiller`);
}

console.log('[post] 完成');
