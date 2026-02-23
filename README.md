# 吉光智界官网（Astro + Tailwind）

基于 `Simple Astro Landing Page Theme` 定制，已完成：

- 企业官网中文化内容
- 响应式布局（移动端/桌面端）
- SEO 基础配置（`title`、`description`、OG、结构化数据）
- `robots.txt` 与 sitemap
- GitHub Pages 自动部署工作流
- 自定义域名 `jiguangzhijie.top`（`public/CNAME`）

## 本地开发

```bash
npm install
npm run dev
```

## 构建验证

```bash
npm run build
npm run preview
```

## 发布到 GitHub Pages

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
