import { initializeSettings } from './config-storage';

void (async () => {
  try {
    await initializeSettings();
    await import('./main');
  } catch (error) {
    const app = document.querySelector<HTMLDivElement>('#app');
    if (app) app.textContent = `无法加载设置：${String(error)}。请检查配置文件后重新启动。`;
    console.error(error);
  }
})();
