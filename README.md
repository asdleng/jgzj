# 吉光智界官网（Astro + Tailwind）

基于 `Simple Astro Landing Page Theme` 定制，已完成：

- 企业官网中文化内容
- 响应式布局（移动端/桌面端）
- SEO 基础配置（`title`、`description`、OG、结构化数据）
- `robots.txt` 与 sitemap
- GitHub Pages 静态发布工作流
- 自定义域名 `jiguangzhijie.top`（`public/CNAME`）
- Node 后端代理 `/api/cloud-chat`，可接入本机 AI 对话服务

## 本地开发

建议使用 Node 20。

```bash
npm install
npm run dev
```

## 构建验证

```bash
npm run build
npm run preview
```

## 带后端运行

这个仓库现在支持“前后端一体部署”：

- 前端构建为 `dist/`
- `backend/server.js` 提供静态网页和 `/api/cloud-chat`
- `/api/cloud-chat` 默认代理到 `http://127.0.0.1:8050/chat/stream`

启动方式：

```bash
npm ci
npm ci --prefix backend
npm run build
PORT=3000 UPSTREAM_CHAT_BASE_URL=http://127.0.0.1:8050 UPSTREAM_CHAT_STREAM_PATH=/chat/stream npm run start --prefix backend
```

详细部署见 [docs/backend-deploy.md](/home/admin1/jgzj/docs/backend-deploy.md)。

如果当前机器系统 `node` 版本太低，可以直接用一键脚本：

```bash
./scripts/start-site.sh
```

默认会：

- 自动下载本地 Node 20 运行时到 `.runtime/`
- 安装前后端依赖
- 构建前端
- 在后台启动网站后端，默认监听 `8888`

停止：

```bash
./scripts/stop-site.sh
```

## 发布到 GitHub Pages

GitHub Pages 只适合静态页演示，不适合生产环境聊天功能，因为它不能运行 Node 后端。

1. 在 GitHub 创建一个空仓库（例如 `jgzj-site`）。
2. 本地执行：

```bash
git init
git branch -M main
git add .
git commit -m "feat: init jiguangzhijie.top site"
git remote add origin <你的仓库地址>
git push -u origin main
```

3. GitHub 仓库设置：
- `Settings` -> `Pages`
- `Build and deployment` 选择 `GitHub Actions`

4. DNS 解析（在域名注册商面板中配置）：
- `@` -> `A` -> `185.199.108.153`
- `@` -> `A` -> `185.199.109.153`
- `@` -> `A` -> `185.199.110.153`
- `@` -> `A` -> `185.199.111.153`
- `www` -> `CNAME` -> `<你的GitHub用户名>.github.io`（可选）

## 关键文件

- 站点配置：`astro.config.mjs`
- 首页内容：`src/pages/index.astro`
- 部署工作流：`.github/workflows/deploy.yml`
- 域名绑定：`public/CNAME`

## 交接文档

- 服务端交接： [docs/JGZJ_SERVER_HANDOFF.md](/home/admin1/jgzj/docs/JGZJ_SERVER_HANDOFF.md)

## 生产部署建议

生产环境请使用支持 Node 的服务器、容器平台或云主机，并参考 [docs/backend-deploy.md](/home/admin1/jgzj/docs/backend-deploy.md)。
