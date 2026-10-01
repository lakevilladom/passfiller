<template>
  <div class="pf-page">
    <header class="pf-header">
      <h1>PassFiller</h1>
      <p class="pf-subtitle">{{ t('subtitle') }}</p>
    </header>
    <main class="pf-card">
      <el-form
        label-width="auto"
        size="large"
      >
        <el-form-item :label="t('urlLabel')">
          <el-input
            v-model="mcpUrl"
            type="password"
            show-password
            :placeholder="t('urlPlaceholder')"
            :disabled="testing"
            @input="parseFeedback = ''"
          />
          <div
            v-if="parseFeedback"
            class="form-tip"
            :class="{ 'parse-ok': parseOk }"
          >
            {{ parseFeedback }}
          </div>
        </el-form-item>

        <el-form-item :label="t('enable')">
          <el-switch v-model="enabled" />
          <div class="form-tip">{{ t('enableDesc') }}</div>
        </el-form-item>

        <el-form-item>
          <el-button
            :loading="testing"
            @click="handleTest"
          >
            {{ t('test') }}
          </el-button>
          <span
            v-if="testResult"
            class="mcp-test"
            :class="testClass"
            >{{ testResult }}</span
          >
        </el-form-item>

        <el-form-item>
          <el-button
            type="primary"
            :loading="saveLoading"
            @click="handleSave"
          >
            {{ t('save') }}
          </el-button>
        </el-form-item>
      </el-form>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  getMcpConfig,
  setMcpConfig,
  parseMcpUrl,
  testMcpConfig,
  ensureMcpPermission,
  type McpSourceConfig,
} from '@/passfiller/mcpSource';
import { logger } from '@/utils/logger';

// ==================== 自带 i18n（专有名词除外仅两种语言，零上游 i18n 依赖） ====================

type PfLocale = 'zh-CN' | 'en';

const MESSAGES: Record<PfLocale, Record<string, string>> = {
  'zh-CN': {
    subtitle: 'MCP 外部凭据源：网页登录框的内联下拉中将合并展示外部密码服务的账号',
    urlLabel: '服务地址',
    urlPlaceholder: '粘贴 MCP 服务地址（含密钥），如 https://mcp.example.com/mcp?key=…',
    parsedOk: '已解析：{endpoint}，密钥已填入',
    parseFail: '地址无效：应形如 https://mcp.example.com/mcp?key=…',
    needUrl: '请先粘贴 MCP 服务地址',
    enable: '启用',
    enableDesc: '外部 MCP 密码服务中的账号将出现在网页登录框的内联下拉中；密钥仅保存在本机浏览器存储。',
    test: '测试连接',
    testOk: '连接成功，服务已解锁',
    testLocked: '已连通，但服务端已锁定，请先在服务端解锁',
    testFail: '连接失败：{msg}',
    save: '保存',
    saved: '已保存',
    loadFailed: '加载配置失败',
    saveFailed: '保存配置失败',
  },
  en: {
    subtitle: 'MCP external credential source: accounts from an external password service appear in the inline dropdown',
    urlLabel: 'Service URL',
    urlPlaceholder: 'Paste the MCP service URL (with key), e.g. https://mcp.example.com/mcp?key=…',
    parsedOk: 'Parsed: {endpoint}, key filled in',
    parseFail: 'Invalid URL: expected https://mcp.example.com/mcp?key=…',
    needUrl: 'Paste the MCP service URL first',
    enable: 'Enable',
    enableDesc:
      'Accounts from an external MCP password service will appear in the inline dropdown on login pages. The key is stored only in this browser’s local storage.',
    test: 'Test connection',
    testOk: 'Connected; service unlocked',
    testLocked: 'Reachable, but the service is locked. Unlock it on the server side first.',
    testFail: 'Connection failed: {msg}',
    save: 'Save',
    saved: 'Saved',
    loadFailed: 'Failed to load configuration',
    saveFailed: 'Failed to save configuration',
  },
};

const locale: PfLocale = (chrome.i18n.getUILanguage() || 'en').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';

const t = (key: string, params?: Record<string, string>): string => {
  let text = MESSAGES[locale][key] ?? MESSAGES.en[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value);
  }
  return text;
};

// ==================== 配置表单（自 McpSourceDialog 移植，页面常驻） ====================

/** 粘贴的 MCP 服务地址（含 key）；已保存配置回显为重建的 URL */
const mcpUrl = ref('');
const enabled = ref(false);
const parseFeedback = ref('');
const parseOk = ref(false);
const saveLoading = ref(false);
const testing = ref(false);
const testResult = ref('');
const testClass = ref('');

/** 已保存配置的镜像（保留 endpoint/key 之外的 toolPrefix 等字段） */
let savedCfg: McpSourceConfig | null = null;

/** 从地址输入解析配置；空串返回 null（= 保留已存配置，仅切换开关） */
const parseInput = (): { endpoint: string; apiKey: string } | null => {
  const trimmed = mcpUrl.value.trim();
  if (!trimmed) return null;
  return parseMcpUrl(trimmed);
};

const loadConfig = async (): Promise<void> => {
  parseFeedback.value = '';
  testResult.value = '';
  try {
    const cfg = await getMcpConfig();
    savedCfg = cfg;
    enabled.value = cfg.enabled;
    mcpUrl.value = cfg.apiKey ? `${cfg.endpoint}?key=${cfg.apiKey}` : '';
  } catch (error) {
    logger.error('McpSettings: 加载配置失败:', error);
    ElMessage.error(t('loadFailed'));
  }
};

onMounted(() => {
  void loadConfig();
});

const handleTest = async (): Promise<void> => {
  testing.value = true;
  testResult.value = '';
  try {
    const parsed = parseInput();
    if (!parsed) {
      testResult.value = mcpUrl.value.trim() ? t('parseFail') : t('needUrl');
      testClass.value = 'mcp-test-fail';
      return;
    }
    parseFeedback.value = t('parsedOk', { endpoint: parsed.endpoint });
    parseOk.value = true;
    const base = savedCfg ?? (await getMcpConfig());
    const cfg: McpSourceConfig = { ...base, enabled: true, ...parsed };
    // 回环 endpoint 需现场申请 optional 权限（远程由 <all_urls> 覆盖）
    const perm = await ensureMcpPermission(cfg.endpoint);
    if (!perm.ok) {
      testResult.value = t('testFail', { msg: perm.message });
      testClass.value = 'mcp-test-fail';
      return;
    }
    const res = await testMcpConfig(cfg);
    if (res.kind === 'error') {
      testResult.value = t('testFail', { msg: res.message });
      testClass.value = 'mcp-test-fail';
    } else if (res.kind === 'locked') {
      testResult.value = t('testLocked');
      testClass.value = 'mcp-test-warn';
    } else {
      testResult.value = t('testOk');
      testClass.value = 'mcp-test-ok';
    }
  } finally {
    testing.value = false;
  }
};

const handleSave = async (): Promise<void> => {
  const parsed = parseInput();
  // 非空但解析失败 → 阻止保存（key 一定是错的）
  if (mcpUrl.value.trim() && !parsed) {
    parseFeedback.value = t('parseFail');
    parseOk.value = false;
    return;
  }
  // 启用时若是回环 endpoint，现场申请权限（远程端点由 <all_urls> 覆盖）
  if (enabled.value) {
    const endpoint = parsed?.endpoint ?? savedCfg?.endpoint ?? '';
    if (endpoint) {
      const perm = await ensureMcpPermission(endpoint);
      if (!perm.ok) {
        testResult.value = t('testFail', { msg: perm.message });
        testClass.value = 'mcp-test-fail';
        return;
      }
    }
  }
  saveLoading.value = true;
  try {
    // 地址为空 = 保留已存 endpoint/key（含 toolPrefix 等高级字段），仅保存开关状态
    await setMcpConfig(parsed ? { enabled: enabled.value, ...parsed } : { enabled: enabled.value });
    savedCfg = await getMcpConfig();
    ElMessage.success(t('saved'));
  } catch (error) {
    logger.error('McpSettings: 保存配置失败:', error);
    ElMessage.error(t('saveFailed'));
  } finally {
    saveLoading.value = false;
  }
};
</script>

<style scoped>
.pf-page {
  min-height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: linear-gradient(135deg, var(--aph-surface) 0%, var(--aph-surface-2) 100%);
}

.pf-header {
  padding: 32px 32px 0;
}

.pf-header h1 {
  margin: 0 0 6px;
  font-size: 24px;
  font-weight: 600;
  color: var(--aph-text-primary, #1f2d3d);
}

.pf-subtitle {
  margin: 0;
  font-size: 13px;
  color: #909399;
}

.pf-card {
  max-width: 640px;
  padding: 28px 32px;
  margin: 20px 32px 40px;
  background: var(--aph-surface, #fff);
  border: 1px solid var(--aph-surface-line, transparent);
  border-radius: 8px;
  box-shadow: 0 2px 12px rgb(0 0 0 / 6%);
}

.form-tip {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.4;
  color: #909399;
}

.parse-ok {
  color: #67c23a;
}

.mcp-test {
  margin-left: 12px;
  font-size: 13px;
}

.mcp-test-ok {
  color: #67c23a;
}

.mcp-test-warn {
  color: #e6a23c;
}

.mcp-test-fail {
  color: #f56c6c;
}
</style>
