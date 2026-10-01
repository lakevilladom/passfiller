#!/usr/bin/env node
// ============================================================================
// gen-patches.js — 从「已组装并手工修复」的源码树反向提取补丁
//
// 场景：上游发版后补丁失配（锚点文件被重构）。流程：
//   1. node scripts/apply.js --src <上游新版> --out build/work   # 失配退出
//   2. 手工修复 build/work 中 messageRouter.ts / HeaderBar.vue
//   3. node scripts/gen-patches.js --upstream <上游新版源码>       # 重新生成补丁
//
// 实现：对现有 patches/*.patch 头部解析出的锚点文件清单，
// 逐文件 git diff --no-index（上游基线 vs 工作树），改写路径头后写回同名补丁。
// ============================================================================

import { parseArgs } from 'node:util';
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({
  options: {
    work: { type: 'string', default: path.join('build', 'work') },
    upstream: { type: 'string', default: path.join('refs', 'account-password-helper') },
  },
});

const workDir = path.resolve(repoRoot, values.work);
const upstreamDir = path.resolve(repoRoot, values.upstream);
const patchesDir = path.join(repoRoot, 'patches');
// 上游侧 LF 归一化基线目录：refs 在 Windows 上常为 autocrlf=true（CRLF 工作区），
// 而 build/work 经 apply.js 归一化为 LF。直接 diff 会整文件误判（P0 bug），
// 故先把上游锚点文件归一化到临时目录再 diff。
const baselineDir = path.join(repoRoot, 'build', 'gen-baseline');

const patchFiles = (await readdir(patchesDir)).filter(name => name.endsWith('.patch')).sort();

/** 从补丁文本解析锚点文件清单（`diff --git a/<path> b/<path>`） */
function anchorFiles(diffText) {
  const files = [];
  for (const line of diffText.split('\n')) {
    const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (m && m[1] === m[2]) files.push(m[1]);
  }
  return files;
}

let failed = false;
try {
  await rm(baselineDir, { recursive: true, force: true });
  for (const name of patchFiles) {
  const patchFile = path.join(patchesDir, name);
  const oldText = await readFile(patchFile, 'utf8');
  const files = anchorFiles(oldText);
  if (files.length === 0) {
    console.warn(`[gen] 跳过（无法解析锚点文件）: ${name}`);
    continue;
  }

  const parts = [];
  for (const rel of files) {
    const upstreamFile = path.join(upstreamDir, rel);
    const workFile = path.join(workDir, rel);

    // 上游文件 LF 归一化基线（与 apply.js copyFileNormalized 同规则：NUL 判二进制原样）
    const baselineFile = path.join(baselineDir, rel);
    await mkdir(path.dirname(baselineFile), { recursive: true });
    const raw = await readFile(upstreamFile);
    if (raw.includes(0)) await writeFile(baselineFile, raw);
    else {
      const text = raw.toString('utf8');
      await writeFile(baselineFile, /\r/.test(text) ? text.replace(/\r\n?/g, '\n') : text);
    }

    let diff;
    // git 传正斜杠路径：避免输出被引号包裹/反斜杠转义，便于下方路径头改写
    const posixBaseline = baselineFile.replaceAll('\\', '/');
    const posixWork = workFile.replaceAll('\\', '/');
    try {
      // git diff --no-index：有差异时退出码为 1，属正常
      diff = execFileSync('git', ['diff', '--no-index', '--src-prefix=a/', '--dst-prefix=b/', posixBaseline, posixWork], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      if (typeof error.stdout === 'string' && error.stdout.length > 0) diff = error.stdout;
      else {
        console.error(`[gen] 无法 diff ${rel}: ${error.message}`);
        failed = true;
        continue;
      }
    }
    if (!diff) {
      console.warn(`[gen] 无差异（文件与上游一致，补丁中将失去该文件）: ${rel}`);
    }
    // 改写路径头（diff --git / --- / +++ 三处）：绝对文件路径 → 仓库相对路径
    const relPosix = rel.replaceAll('\\', '/');
    const norm = diff
      .replaceAll(`a/${posixBaseline}`, `a/${relPosix}`)
      .replaceAll(`b/${posixWork}`, `b/${relPosix}`);
    parts.push(norm.endsWith('\n') ? norm : norm + '\n');
  }

  const newText = parts.join('\n');
  if (newText.trim().length === 0) {
    console.warn(`[gen] ${name} 生成结果为空，保留原文件不覆盖`);
    continue;
  }
  await writeFile(patchFile, newText, 'utf8');
  console.log(`[gen] 已重新生成: ${name}（${files.length} 个锚点文件）`);
  }
} finally {
  await rm(baselineDir, { recursive: true, force: true }).catch(() => {});
}

if (failed) process.exit(1);
console.log('[gen] 完成');
