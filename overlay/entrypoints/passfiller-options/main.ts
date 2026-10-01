import { createAndMountApp } from '@/utils/createVueApp';
import App from './McpSettings.vue';
import { initThemeSync } from '@/utils/theme';
// 与上游 Options 页共用同一套设计令牌（主题色 / 暗色模式变量），保持观感一致
import '@/assets/theme/tokens.css';

// 尽早读取并应用主题（fire-and-forget），并监听配置变更实时切换
initThemeSync();

createAndMountApp(App);
