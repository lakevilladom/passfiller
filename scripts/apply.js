#!/usr/bin/env node
// ============================================================================
// apply.js — PassFiller 组装器
//
// 把「上游源码 + overlay 新增文件 + patches 补丁」组装成可构建的完整扩展源码树。
// CI（sync-patch-build.yml）与本地开发（--materialize）共用同一入口。
//
// 用法：
//   node scripts/apply.js --src <上游源码目录> --out <组装输出目录>
//   node scripts/apply.js --materialize            # 本地开发：
//     --src 默认 refs/account-password-helper，--out 默认 build/work
//
// 步骤：
//   1. 清空并重建 out
//   2. 复制上游源码（排除 .git / node_modules / .output / .wxt / dist）
//   3. 复制 overlay/*（全部为新增文件，与上游零冲突）
//   4. 按文件名顺序 git apply patches/*.patch（任一失配即非零退出，CI 变红）
// ============================================================================

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

// ---------- 1. 重建输出目录 ----------
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// ---------- 2. 复制上游源码（排除缓存与 git 元数据） ----------
const UPSTREAM_IGNORE = new Set(['.git', 'node_modules', '.output', '.wxt', 'dist']);

/**
 * 复制并统一换行为 LF：
 * Windows 上 refs 若以 core.autocrlf=true checkout，工作区文件为 CRLF，
 * 而上游守卫测试的判据字符串、补丁上下文均按 LF 书写（CI 在 ubuntu 上克隆为 LF）。
 * 归一化使组装树与 CI 完全一致；含 NUL 字节的二进制文件原样复制。
 */
async function copyFileNormalized(src, dest) {
  const buf = await readFile(src);
  if (buf.includes(0)) {
    await writeFile(dest, buf);
    return;
  }
  const text = buf.toString('utf8');
  await writeFile(dest, /\r/.test(text) ? text.replace(/\r\n?/g, '\n') : text);
}

/** 递归复制，跳过 ignore 中的顶层目录 */
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

// ---------- 3. 叠加 overlay（纯新增文件） ----------
console.log(`[apply] 叠加 overlay: ${overlayDir}`);
await copyTree(overlayDir, outDir);

// ---------- 4. 应用补丁 ----------
const patches = (await readdir(patchesDir))
  .filter(name => name.endsWith('.patch'))
  .sort();
if (patches.length === 0) {
  console.error(`[apply] patches 目录为空: ${patchesDir}`);
  process.exit(1);
}

for (const name of patches) {
  const patchFile = path.join(patchesDir, name);
  // GIT_CEILING_DIRECTORIES=仓库根：阻止 git 向上发现本仓库 .git，
  // 否则 git apply 视组装树为仓库子目录、补丁路径被解释为相对仓库根且不在 cwd 下，
  // 会静默 Skip（退出码 0）——本地 build/ 与 CI 的 assembled/ 均中招（产物缺补丁）。
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: repoRoot };
  try {
    // --check 先行：失败时 git 输出定位到具体 hunk，便于排障
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
