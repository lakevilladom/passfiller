基于上游 [account-password-helper {{UPSTREAM_TAG}}](https://github.com/{{UPSTREAM_REPO}}/releases/tag/{{UPSTREAM_TAG}}) 嵌入 PassFiller 打包。

## PassFiller 功能

- **MCP 外部凭据源**：网页登录框内联下拉合并展示外部密码服务账号，点击填充时按条目委托服务端解密（明文不在本地留存）
- **独立设置页**：管理页右上角菜单 → PassFiller

## 安装

- **crx（自动更新）**：配置企业策略 `ExtensionInstallForcelist` = `"{{APP_ID}};{{UPDATE_URL}}"`，Chrome 会自动静默安装并保持更新
- **zip（手动）**：解压后 Chrome 扩展页开启开发者模式 → 加载已解压的扩展程序
