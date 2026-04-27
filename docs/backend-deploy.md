
## 后端部署方案

这个站点现在采用“前后端一体部署”：

- 前端仍然由 Astro 构建为静态文件 `dist/`
- `backend/server.js` 用 Express 提供网页和 `/api/cloud-chat`
- `/api/cloud-chat` 会把消息代理到本机聊天服务 `http://127.0.0.1:8050/chat/stream`
- 运行环境建议使用 Node 20

## 为什么不能继续只用 GitHub Pages

GitHub Pages 只能托管静态文件，不能运行 Node 服务，也就不能提供 `/api/cloud-chat` 这种后端接口。

如果要让公网网页上的对话框可用，生产环境必须部署到支持 Node 的服务器或容器平台。

## 服务器直跑 Node

适合你的当前场景：聊天服务已经在同一台机器的 `127.0.0.1:8050` 跑起来了。

1. 安装依赖

```bash
npm ci
npm ci --prefix backend
```

2. 构建前端

```bash
npm run build
```

3. 启动后端

```bash
PORT=3000 \
UPSTREAM_CHAT_BASE_URL=http://127.0.0.1:8050 \
UPSTREAM_CHAT_STREAM_PATH=/chat/stream \
npm run start --prefix backend
```

4. 验证

```bash
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/api/health
curl -X POST http://127.0.0.1:3000/api/cloud-chat \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"probe","message":"你好"}'
```

## 建议的 Nginx 反代

域名指向这台服务器后，把外部流量反代到 `127.0.0.1:3000`：

```nginx
server {
    listen 80;
    server_name jiguangzhijie.top www.jiguangzhijie.top;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

如果已经配了 HTTPS，把 `listen 80` 换成你的 TLS 配置即可。

## Docker Compose 方式

如果你想把官网后端跑在容器里，而聊天服务仍然跑在宿主机：

- 宿主机聊天服务地址不能再写 `127.0.0.1`
- 容器内应使用 `http://host.docker.internal:8060`
- Linux Docker 需要 `extra_hosts: host-gateway`

已提供示例文件：`deploy/docker-compose.backend.yml`

启动：

```bash
docker compose -f deploy/docker-compose.backend.yml up -d
```

## 环境变量

- `PORT`: 官网后端监听端口，默认 `3000`
- `UPSTREAM_CHAT_BASE_URL`: 本机聊天服务根地址，默认 `http://127.0.0.1:8050`
- `UPSTREAM_CHAT_STREAM_PATH`: 流式对话接口路径，默认 `/chat/stream`
- `UPSTREAM_CHAT_HEALTH_PATH`: 健康检查路径，默认 `/healthz`
- `CHAT_PROXY_TIMEOUT_MS`: 代理超时，默认 `120000`

## 当前接口关系

- 公网用户访问：`https://你的域名/`
- 网页聊天框调用：`https://你的域名/api/cloud-chat`
- 官网后端再转发到：`http://127.0.0.1:8050/chat/stream`
