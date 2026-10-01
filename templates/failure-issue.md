上游 [`{{UPSTREAM_TAG}}`](https://github.com/{{UPSTREAM_REPO}}/releases/tag/{{UPSTREAM_TAG}}) 触发的自动组装失败。

## 常见原因

补丁锚点失配（上游重构了 `messageRouter.ts` / `HeaderBar.vue`）。

## 修复流程

1. 本地 `node scripts/apply.js --src <上游源码> --out build/work`
2. 手工修复 build/work 中失配文件
3. `node scripts/gen-patches.js --upstream <上游源码>` 重新生成补丁
4. 提交并手动触发 sync-upstream workflow

## 失败日志

{{FAILURE_URL}}
