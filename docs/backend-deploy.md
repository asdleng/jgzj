
## 后端部署方案（自动生成 2026-03-06 22:15:57）
- 任务说明: 把这个网站仓库，现在是github部署，无法用后端，给我弄一个新的分支，用有后端方案，然后写个说明告诉我如何在服务器上部署
- 部署建议: 使用支持后端运行的服务器（云主机/容器平台），不要依赖纯 GitHub Pages。
- Node 方案: 构建前端产物后由 backend/server.js 提供静态站点和 /api/health。
- 启动命令: `npm ci --prefix backend && npm run start --prefix backend`。
- 反向代理: Nginx/Caddy 指向 3000 端口。
