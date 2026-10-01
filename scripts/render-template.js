#!/usr/bin/env node
// ============================================================================
// render-template.js — 极简 {{占位符}} 模板渲染器
//
// 用途：把工作流里内联在 YAML 的 XML / Markdown「内容生成」抽成独立模板文件，
//       避免 heredoc + shell 转义的混乱，并让版本文案可本地预览 / lint。
//
// 占位符语法：{{ KEY }}（KEY 为 [A-Za-z_][A-Za-z0-9_]*）；未提供的占位符会
//           使渲染失败退出（防止漏填导致线上产物缺字段）。
//
// 用法：
//   node scripts/render-template.js \
//        --template templates/updates.xml --output pages/updates.xml \
//        --var APP_ID=xxx --var VERSION=1.2.3 --var "CODEBASE_URL=https://..."
// ============================================================================

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const { values } = parseArgs({
  options: {
    template: { type: 'string' },
    output: { type: 'string' },
    var: { type: 'string', multiple: true, default: [] },
  },
});

if (!values.template || !values.output) {
  console.error('用法: node scripts/render-template.js --template <in> --output <out> [--var KEY=VALUE ...]');
  process.exit(2);
}

// 收集 --var KEY=VALUE（取第一个 = 分隔；VALUE 可含 =）
const vars = {};
for (const kv of values.var) {
  const i = kv.indexOf('=');
  if (i <= 0) {
    console.error(`[tpl] --var 格式错误（应为 KEY=VALUE）: ${kv}`);
    process.exit(2);
  }
  vars[kv.slice(0, i)] = kv.slice(i + 1);
}

const raw = readFileSync(values.template, 'utf8');
const missing = [];
const rendered = raw.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, key) => {
  if (!(key in vars)) {
    missing.push(key);
    return m;
  }
  return vars[key];
});

if (missing.length > 0) {
  console.error(`[tpl] 模板 ${values.template} 缺少变量: ${[...new Set(missing)].join(', ')}`);
  process.exit(1);
}

mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
writeFileSync(values.output, rendered);
console.log(`[tpl] ${values.template} → ${values.output}（${Object.keys(vars).length} 个变量）`);
