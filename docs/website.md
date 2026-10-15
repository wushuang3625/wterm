# 产品介绍页

网站：<https://wushuang3625.github.io/wterm/>。

## 内容与结构

- `docs/index.html`：中文首页、功能介绍、可切换的 SSH/SFTP/AI 界面示意、下载入口与常见问题。
- `docs/assets/site.css`：响应式布局、深浅主题和减少动画设置。
- `docs/assets/site.js`：中英文、主题、演示标签的键盘操作与复制反馈。偏好仅保存在访问者浏览器；不收集表单数据，不调用模型接口。
- `docs/assets/wterm.png`：沿用应用图标。
- `docs/.nojekyll`：使用纯静态文件，不进行 Jekyll 转换。

界面示意使用演示域名和示例内容，不连接真实服务器。网站区分源码功能和发布安装包；下载入口指向 GitHub 最新 Release，不写死安装包版本。更改源码版本时同步更新首页和英文文案中的版本说明。

## 预览与验证

在仓库根目录运行现有的前端预览服务，访问 `/docs/`：

```powershell
npm run dev:web -- --host 127.0.0.1 --port 1421
```

专项验证：

```powershell
npx playwright test tests/website.ui.spec.ts --reporter=line
```

5 项用例检查演示与键盘操作、语言及主题恢复、复制成功与失败反馈、常见问题及下载目标，以及中英文在 320/390/768/1440px 下的横向溢出。验证使用桌面浏览器的视口模拟，不代表真实手机或全部浏览器验收。

## 发布方式

GitHub Pages 的发布源为 `main` 分支的 `/docs` 目录。将上述页面文件提交并推送到 `main` 后，GitHub 自动发布。无需安装额外依赖、生成前端构建包或提供自定义服务器。

首次由有权限的维护者开启 Pages，之后可在仓库 Settings → Pages 查看发布状态，在 Actions 查看系统生成的 `pages build and deployment` 记录。发布后检查首页、样式、脚本、图标和下载链接，再更新仓库 About 的网站链接。

参考：[GitHub Pages 发布源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。
