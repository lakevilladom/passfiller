# PassFiller

**补丁库**：每次上游 [account-password-helper](https://github.com/liaolongdong/account-password-helper) 发版，GitHub Actions 自动把 MCP 外部凭据源功能嵌入上游代码、重新打包并发布为独立浏览器扩展 **PassFiller**（改名、自行分发，不上 CWS）。

```
上游 tag ──▶ assemble(overlay+补丁) ──▶ install/typecheck/test/build ──▶ postprocess ──▶ zip+crx ──▶ Release + gh-pages
```

## 仓库结构

| 目录/文件 | 作用 |
|---|---|
| `overlay/` | PassFiller 功能代码（**纯新增文件**，组装时整棵复制进上游树，零冲突） |
| `patches/` | 对上游的全部改动：**仅 2 个补丁 / 2 个文件 / 2 个 hunk** |
| `scripts/` | 工具链（CI 与本地共用同一入口） |
| `.github/workflows/sync-patch-build.yml` | 每 6h 轮询上游 + 手动触发；全链路验证后发布 |

### overlay/

```
overlay/
├── passfiller/
│   ├── index.ts        ← 门面：上游唯一引用点（@/passfiller）
│   └── mcpSource.ts    ← MCP 凭据源薄适配器
└── entrypoints/passfiller-options/   ← WXT 独立设置页（自带中英文）
```

### patches/（极限敞口）

- `0001-messageRouter-import-passfiller.patch`：import 改道——从 `'./passwordCache'` 的 import 块移走 `getMatchingAccounts, getDecryptedEntryById` 两名字，新增 `import { ... } from '@/passfiller'`。L150/L272/L780 调用点零改动，自动走门面（含 `handleSetPendingTotp` 的间接覆盖）。
- `0002-headerbar-passfiller-entry.patch`：HeaderBar.vue 模板追加 `<el-dropdown-item><a href="/passfiller-options.html" target="_blank">PassFiller</a></el-dropdown-item>`——零脚本/零 import/零 i18n。

### scripts/

| 脚本 | 用途 | CI |
|---|---|---|
| `apply.js` | 组装：复制上游(LF 归一化) → 叠 overlay → 依次打补丁；`--materialize` 本地开发 | ✅ |
| `postprocess.js` | 构建后处理：manifest 注入版本 `{上游版本}.{pf迭代}` / 改名 PassFiller / `optional_host_permissions`(回环) / `update_url` | ✅ |
| `package-artifacts.js` | 零依赖打包：chrome-mv3 → zip + crx3（RSA 签名，含 appid 防错校验） | ✅ |
| `gen-patches.js` | 补丁失配修复：手工修复组装树后反向重新生成补丁（上游侧 LF 归一化后再 diff） | ❌ |

> `git apply` 在本脚本中以 `GIT_CEILING_DIRECTORIES` 隔离仓库上下文——否则组装树被识别为仓库子目录时补丁会被**静默 Skip（退出码 0）**，产物缺功能。

## 对上游的依赖面（typechange/typecheck 兜底，非静默断裂）

overlay 复用以下上游内部模块（上游重构它们时 CI 的 typecheck 会变红，属人工介入信号而非静默故障）：

`@/utils/logger`、`@/utils/favicon`、`@/utils/types`、`utils/createVueApp`、`assets/theme/tokens.css`、`entrypoints/background/passwordCache`（门面本质耦合，无法避免）

## 安全模型（MCP 凭据源）

- 线协议：`query_password`（只回元数据，**绝不含密码**）+ `get_entry`（用户显式点击填充时按条目取明文）
- API Key 存 `chrome.storage.local`；调用走 `Bearer`；fetch 10s 超时
- 本地锁定但 MCP 有货仍供给；MCP 条目 id 带 `mcp:` 前缀，`getDecryptedEntryById` 据此路由委托
- 回环 endpoint 经 `optional_host_permissions` 现场申请；远程由 `<all_urls>` 覆盖

## 本地开发

要求：Node ≥ 20.15 + pnpm（版本对齐上游 `packageManager`）+ git

```powershell
node scripts/apply.js --src refs/account-password-helper --out build/work   # 或 --materialize
cd build/work
pnpm install
pnpm typecheck; pnpm test:run; pnpm exec wxt build
node ../scripts/postprocess.js --out .output/chrome-mv3 --version 3.13.1.1
node ../scripts/package-artifacts.js --dir .output/chrome-mv3 --zip out.zip --crx out.crx --key build/crx-private.pem --appid <appid>
```

`refs/` 与 `build/` 均不入库：CI 在 runner 上自行 clone 上游；本地 `refs/` 仅为免网络的参考镜像。

### 补丁失配（上游重构锚点文件）

1. CI 变红（失败步骤在 Actions 运行页可见）
2. 本地 `apply.js --out build/work` 失配退出 → 手工修复 `build/work` 中对应文件
3. `node scripts/gen-patches.js --work build/work --upstream <上游>` 重新生成补丁
4. 重跑组装/构建验证后提交

## 发布与自动更新

### 首次配置

1. 生成 RSA 2048 / PEM·PKCS#1 私钥：
   ```bash
   ssh-keygen -t rsa -b 2048 -m PEM -f crx-private.pem -N ""
   ```
2. 将私钥存入仓库 Secrets（CI 签名的唯一密钥来源）：
   - 仓库页面 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
   - **Name**：`CRX_PRIVATE_KEY`
   - **Secret**：粘贴 `crx-private.pem` 的**全文**（含 `-----BEGIN RSA PRIVATE KEY-----` 与 `-----END RSA PRIVATE KEY-----` 及中间所有内容与换行）
   - 点击 **Add secret**
3. 删除本地私钥副本（密钥已入库 + 请另存一份**离线备份**；丢失 = 扩展 ID 变更 = 自动更新链断裂）：
   ```bash
   rm crx-private.pem
   ```

> 扩展 ID 不写死：构建时由 `CRX_PRIVATE_KEY` 的公钥实时派生，自动注入 `updates.xml`。

### 更换密钥

重新执行「首次配置」第 1–2 步生成新密钥并**更新**同一个 Secret `CRX_PRIVATE_KEY`（覆盖旧值）即可，其余全自动产生。

   >  **更换密钥的风险**：Chrome 自托管 crx 的扩展 ID 由公钥决定，换密钥 = 扩展 ID 改变 = 已安装老用户的自动更新链断裂（`updates.xml` 里的 appid 与老扩展对不上）。需当作「新扩展」迁移：通知用户重装，或企业侧更新 `ExtensionInstallForcelist` 的 appid 后用新 id 重新推送。旧 Release 里的旧 crx 仍可用，但与新 `updates.xml` 互不关联。
### 产物

- `PassFiller-v{版本}-chrome.zip`：开发者模式「加载已解压的扩展程序」
- `PassFiller-v{版本}.crx`：**企业策略安装**（唯一静默自动更新路径）：
  ```
  HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
  值 = "<扩展ID>;https://<owner>.github.io/<repo>/updates.xml"
  ```
  Chrome 每 ~5h 查询 gh-pages 上的 `updates.xml`（codebase 指向 Release 资产，可跟随 302），版本更高即静默更新。普通访客无此策略时不会自动更新（Chrome 安全模型）。

### CI 流程（sync-patch-build.yml）

`gh api` 查上游 latest → 以自有 tag `v{上游版本}-pf*` 判重 → clone 上游@tag → 组装 → `pnpm install/typecheck/test/build` → postprocess → zip+crx → `gh release create` → 部署 `updates.xml` 到 gh-pages。任一步失败即红。

## 测试

上游全量测试（`pnpm test:run`）+ PassFiller 自有测试（`overlay/tests/passfiller/`，覆盖 `parseMcpUrl` / `isMcpId` / `isLoopbackEndpoint` / `callMcpTool` 响应映射等协议解析逻辑）在组装树中一并执行。
