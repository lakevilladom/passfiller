#!/usr/bin/env node
// apply.js — 组装器：上游源码 + overlay 新增文件 + patches 补丁 → 完整扩展源码树。
// CI（sync-patch-build.yml）与本地（--materialize）共用同一入口。
// 用法: node scripts/apply.js --src <上游目录> --out <输出目录> [--materialize]

import { parseArgs } from 'node:util';
import { mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({
  options: {
    src: { type: 'string' },
    out: { type: 'string' },
    materialize: { type: 'boolean', default: false },
  },
});

const srcDir = path.resolve(
  repoRoot,
  values.src ?? (values.materialize ? path.join('refs', 'account-password-helper') : ''),
);
const outDir = path.resolve(
  repoRoot,
  values.out ?? (values.materialize ? path.join('build', 'work') : ''),
);
const overlayDir = path.join(repoRoot, 'overlay');
const patchesDir = path.join(repoRoot, 'patches');

if (!values.src && !values.materialize) {
  console.error('用法: node scripts/apply.js --src <上游源码目录> --out <输出目录> [--materialize]');
  process.exit(2);
}
if (!existsSync(srcDir)) {
  console.error(`[apply] 上游源码目录不存在: ${srcDir}`);
  process.exit(2);
}
if (!existsSync(overlayDir)) {
  console.error(`[apply] overlay 目录不存在: ${overlayDir}`);
  process.exit(2);
}

// 重建输出目录
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// 复制上游源码（排除缓存与 git 元数据）
const UPSTREAM_IGNORE = new Set(['.git', 'node_modules', '.output', '.wxt', 'dist']);

// LF 归一化：refs 在 Windows 上可能 CRLF，而 CI/补丁按 LF；NUL 字节视为二进制原样复制。
async function copyFileNormalized(src, dest) {
  const buf = await readFile(src);
  if (buf.includes(0)) {
    await writeFile(dest, buf);
    return;
  }
  const text = buf.toString('utf8');
  await writeFile(dest, /\r/.test(text) ? text.replace(/\r\n?/g, '\n') : text);
}

// 递归复制，跳过顶层 ignore 目录
async function copyTree(from, to, ignoreTop = new Set()) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (ignoreTop.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dest, new Set());
    else await copyFileNormalized(src, dest);
  }
}

console.log(`[apply] 上游源码: ${srcDir}`);
await copyTree(srcDir, outDir, UPSTREAM_IGNORE);

// 叠加 overlay（纯新增文件）
console.log(`[apply] 叠加 overlay: ${overlayDir}`);
await copyTree(overlayDir, outDir);

// 应用补丁
const patches = (await readdir(patchesDir))
  .filter(name => name.endsWith('.patch'))
  .sort();
if (patches.length === 0) {
  console.error(`[apply] patches 目录为空: ${patchesDir}`);
  process.exit(1);
}

for (const name of patches) {
  const patchFile = path.join(patchesDir, name);
  // 隔离仓库上下文：否则 git 视组装树为仓库子目录、静默 Skip 补丁（退出码 0），产物缺功能。
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: repoRoot };
  try {
    // --check 先行，失败时可定位到具体 hunk
    execFileSync('git', ['apply', '--check', patchFile], { cwd: outDir, env, stdio: 'inherit' });
    execFileSync('git', ['apply', patchFile], { cwd: outDir, env, stdio: 'inherit' });
    console.log(`[apply] 补丁已应用: ${name}`);
  } catch {
    console.error(`\n[apply] 补丁应用失败: ${name}`);
    console.error('[apply] 通常是上游重构了锚点文件。请在 build/work 中手工修复对应文件，');
    console.error('[apply] 然后运行 node scripts/gen-patches.js --work <该目录> --upstream <上游目录> 重新生成补丁。');
    process.exit(1);
  }
}

console.log(`[apply] 组装完成: ${outDir}`);
