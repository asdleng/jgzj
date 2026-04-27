# JGZJ Server Handoff

更新时间：2026-04-27  
项目根目录：`/home/admin1/jgzj`  
适用范围：这份文档只覆盖这台机器上和 `jgzj` 官网及其演示能力强相关的服务，不试图描述整台服务器上的所有无关进程。

## 1. 先看什么

如果下一个智能体要快速接手，建议按这个顺序看：

1. 本文档：先理解整机链路和服务边界。
2. [README.md](/home/admin1/jgzj/README.md)：看站点本身的开发和部署方式。
3. [backend/server.js](/home/admin1/jgzj/backend/server.js)：看官网后端聚合了哪些能力。
4. [backend/runtime-control.js](/home/admin1/jgzj/backend/runtime-control.js)：看“云端智能运维”页当前监控和重启哪些节点。
5. [backend/cloud-mapping.js](/home/admin1/jgzj/backend/cloud-mapping.js)：看“大规模云端建图”页的服务端逻辑。
6. [src/pages](/home/admin1/jgzj/src/pages)：看当前网站有哪些演示页。

## 2. 站点和服务总览

`jgzj` 不是纯静态站点。它本身是一个 `Astro + Express` 项目，但它展示的能力依赖几条仓库外的服务链：

- 官网后端：`127.0.0.1:8888`
- 云端对话桥：`127.0.0.1:8050`
- 云端车端 agent：`127.0.0.1:8000`
- AI 检测 WebSocket：`127.0.0.1:8794`
- Qwen3.6 文本 tunnel：`127.0.0.1:18000`
- Qwen3.6 多模态 tunnel：`127.0.0.1:18001`
- FRP：把公网入口转到本机服务

当前公网入口：

| 公网入口 | 本机服务 | 作用 |
|---|---:|---|
| `http://idtrd.kmdns.net:7788` | `127.0.0.1:8000` | cloud-agent，车端状态 / 工具调用 / 运维 WS |
| `http://idtrd.kmdns.net:7789` | `127.0.0.1:8794` | Qwen-VL 检测 WebSocket |
| `http://idtrd.kmdns.net:7790` | `127.0.0.1:8050` | 云端文本对话桥 |
| `http://idtrd.kmdns.net:7791` | `127.0.0.1:8888` | 官网前后端一体服务 |

2026-04-27 当前检查结果：

- `http://127.0.0.1:8888/healthz`：`ok`
- `http://127.0.0.1:8050/healthz`：`ok`
- `http://127.0.0.1:8022/healthz`：`ok`
- `http://127.0.0.1:8042/healthz`：`ok`
- `http://127.0.0.1:8043/healthz`：`ok`
- `http://127.0.0.1:8051/healthz`：`ok`
- `http://127.0.0.1:8024/healthz`：`ok`
- `http://127.0.0.1:8000/healthz`：`connected_vehicle_count=17`
- `http://idtrd.kmdns.net:7790/healthz`：`ok`
- `http://idtrd.kmdns.net:7791/healthz`：`ok`

## 3. `jgzj` 仓库内负责什么

### 3.1 前端页面

当前页面入口：

- `/`：行业爆发
- `/l4-autonomous-driving/`：L4 园区自动驾驶
- `/edge-cloud-ai-inspection/`：端云协同 AI 检测
- `/intelligent-ai-dialogue/`：智能 AI 对话交互
- `/cloud-operations/`：云端智能运维
- `/distributed-map-management/`：分布地图云端统一管理
- `/cloud-mapping/`：大规模云端建图
- `/cases-awards/`：案例与奖项

页面源码都在 [src/pages](/home/admin1/jgzj/src/pages)。

### 3.2 官网后端

主文件是 [backend/server.js](/home/admin1/jgzj/backend/server.js)。

它做了几件事：

- 提供 `dist/` 静态站点
- 提供基础健康检查
- 代理网页聊天到 `8050`
- 对接本机 `cloud-agent`
- 对接本机 `Qwen3.6` 文本 / 多模态能力
- 提供 OpenClaw 登录态和自然语言运维
- 提供 AI 检测历史查询
- 提供地图编辑器桥接
- 注册 `cloud-mapping` 子模块
- 注册 `runtime-control` 子模块

主要接口分组：

- 基础：`/healthz`、`/api/health`
- 对话：`/api/cloud-chat`
- OpenClaw：`/api/openclaw-auth-status`、`/api/openclaw-login`、`/api/openclaw-logout`、`/api/openclaw-health`、`/api/openclaw-chat`
- 云端运维：`/api/cloud-agent-health`、`/api/cloud-ops/vehicles`、`/api/cloud-ops/vehicles/:vehicleId`、`/api/cloud-ops/execute`
- 地图编辑器桥：`/api/map-editor/:vehicleId/status|start|stop`、`/vehicles/:vehicleId/map-editor`
- AI 检测：`/api/ai-check-history`、`/api/ai-check-history/:requestRowId`
- Qwen3.6：`/api/qwen36-health`、`/api/qwen36-chat`、`/api/qwen36-mm-check`
- 云端建图：由 [backend/cloud-mapping.js](/home/admin1/jgzj/backend/cloud-mapping.js) 注册
- 节点状态 / 重启：由 [backend/runtime-control.js](/home/admin1/jgzj/backend/runtime-control.js) 注册

## 4. 当前服务链路怎么拼起来

### 4.1 7791 官网链路

链路：

`浏览器 -> 7791 -> 8888 Node/Express -> 站内 API / 其他本机服务`

本地服务：

- 监听：`*:8888`
- 进程管理：`tmux` 会话 `jgzj-site`
- 日志：`/home/admin1/jgzj/.logs/web-backend.log`
- 启动脚本：[scripts/start-site.sh](/home/admin1/jgzj/scripts/start-site.sh)
- 停止脚本：[scripts/stop-site.sh](/home/admin1/jgzj/scripts/stop-site.sh)
- 自重启脚本：[scripts/restart-site-detached.sh](/home/admin1/jgzj/scripts/restart-site-detached.sh)

注意：

- `start-site.sh` 每次都会重新 `npm ci`、`npm ci --prefix backend`、`npm run build`，所以不是秒级重启。
- 网页内点“重启官网”时，实际走的是异步 `restart-site-detached.sh`，会有短暂中断。
- 本项目内嵌了 Node 20 运行时到 `.runtime/node-v20.20.1-linux-x64/`，不要假设系统 `node` 可用。

### 4.2 7790 对话链路

生产链路：

`7790 -> 8050 -> 8022 -> 8043 -> 18000`

灰度链路：

`8051 -> 8024 -> 8042 -> 18000`

对应 systemd 服务：

- `jgzj-chat-bridge-8050-qwen35.service`
- `jgzj-chat-bridge-8051-qwen36.service`
- `jgzj-intent-v2-8022-failover.service`
- `jgzj-intent-v2-8024.service`
- `jgzj-llm-failover-8043.service`
- `jgzj-qwen36-compat-8042.service`
- `jgzj-qwen36-text-tunnel.service`
- `jgzj-qwen36-mm-tunnel.service`
- `jgzj-a100-cosyvoice-tunnel.service`

当前监听：

- `*:8050`
- `*:8051`
- `*:8022`
- `*:8042`
- `*:8043`
- `127.0.0.1:18000`
- `127.0.0.1:18001`

相关切换脚本：

- [scripts/switch_jgzj_llm_chain.sh](/home/admin1/jgzj/scripts/switch_jgzj_llm_chain.sh)
- [scripts/switch_jgzj_intent_llm.sh](/home/admin1/jgzj/scripts/switch_jgzj_intent_llm.sh)

脚本含义：

- `switch_jgzj_llm_chain.sh qwen35|qwen36|status`：切 `8050` 对话桥目标
- `switch_jgzj_intent_llm.sh failover|qwen35|status`：切 `8022` 意图链路目标

### 4.3 7788 cloud-agent / 车端运维链路

这个服务不在 `jgzj` 仓库里，目录是：

`/home/admin1/cloud_control`

主入口：

- 启动脚本：`/home/admin1/cloud_control/start_cloud_agent.sh`
- 主程序：`/home/admin1/cloud_control/cloud_agent_server.py`

本地监听：

- `127.0.0.1:8000`

对外能力：

- HTTP 健康检查：`/healthz`
- 车辆列表：`/api/vehicles`
- 单车详情：`/api/vehicles/{vehicle_id}`
- 工具列表：`/api/vehicles/{vehicle_id}/tool-list`
- 工具调用：`/api/vehicles/{vehicle_id}/tools/{tool_name}`
- 车端 WS：`/`、`/ws/car`、`/agent/car`
- 运维 WS：`/ws/ops`

当前状态：

- 管理方式：`tmux` 会话 `cloud-agent`
- 健康检查显示 `connected_vehicle_count=17`
- 示例车辆有 `BIT-0001`、`BIT-0011`、`BIT-0013`、`BIT-0014`、`BIT-0015`、`BIT-0019`

### 4.4 7789 AI 检测链路

这个服务也不在 `jgzj` 仓库里，目录是：

`/home/admin1/qwen-vl-infer`

链路：

`7791 网页 -> 8888 /api/qwen36-mm-check 或 AI 检测历史接口`

以及独立的车端 WebSocket 检测链：

`7789 -> 8794 qwen_ws_checker_service -> 8012 vLLM`

关键文件：

- 启动脚本：`/home/admin1/qwen-vl-infer/start_qwen_ws_checker_stack.sh`
- WebSocket 服务：`/home/admin1/qwen-vl-infer/qwen_ws_checker_service.py`
- 客户端示例：`/home/admin1/qwen-vl-infer/car_ws_client.py`

当前监听：

- `*:8794`
- `127.0.0.1:8012`

当前管理方式：

- 不是 systemd
- 不是 tmux
- `start_qwen_ws_checker_stack.sh` 用 `nohup setsid` 起 `vllm` 和 `python`

归档路径：

- 图片与请求档案：`/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive`
- SQLite：`/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive/qwen_ws_checker.sqlite3`

### 4.5 A100 tunnel

目录：

`/home/admin1/a100_tunnel`

关键脚本：

- `start_qwen36_local_tunnel.sh`
- `start_a100_local_tunnel.sh`

当前 systemd tunnel：

- `18000 -> A100 8000`：Qwen3.6 文本
- `18001 -> A100 8001`：Qwen3.6 多模态
- `18109 -> A100 8909`：CosyVoice TTS

注意：

- 这些 tunnel 使用本机私钥直连 `192.168.80.49`
- 不要把私钥、frp token、cookie secret 再复制进新文档或聊天记录

### 4.6 FRP

FRP 目录：

`/home/admin1/frp/frp_0.65.0_linux_amd64`

关键文件：

- `frpc`
- `frpc.toml`
- `frpc.log`

当前状态：

- 不是 systemd
- 当前由独立进程运行
- `runtime-control` 通过匹配 `frpc.toml` 进程来判断状态

项目内重启脚本：

- [scripts/restart-frpc.sh](/home/admin1/jgzj/scripts/restart-frpc.sh)

## 5. `cloud-operations` 页当前到底能管什么

`/cloud-operations/` 现在有两层能力：

1. 车端运维工作台  
依赖 `cloud-agent`、OpenClaw、车辆工具链。

2. 云端关键节点状态面板  
依赖 [backend/runtime-control.js](/home/admin1/jgzj/backend/runtime-control.js)。

当前被监控和可重启的节点：

- `site-web`：官网后端 `8888`
- `frpc-public`：FRP
- `chat-bridge-8050`
- `intent-8022`
- `llm-failover-8043`
- `qwen36-compat-8042`
- `qwen36-text-18000`
- `qwen36-mm-18001`

接口：

- `GET /api/cloud-ops/runtime/status`
- `POST /api/cloud-ops/runtime/restart`

重启要求：

- 只读状态可看，不可重启
- 必须先通过 OpenClaw 登录

## 6. `cloud-mapping` 页当前到底做什么

服务端实现： [backend/cloud-mapping.js](/home/admin1/jgzj/backend/cloud-mapping.js)

它不是自己做 SLAM，而是负责：

- 登录鉴权
- 接收 bag 上传
- 保存运行态到 `.runtime/cloud-mapping`
- 调外部建图脚本
- 暴露下载结果

关键外部依赖：

- 建图脚本：`/home/admin1/auto_ad_mapping/run_vlio_mapping_to_map.sh`
- 源地图目录：`/home/admin1/auto_ad_mapping/map`

项目内运行目录：

- 上传目录：`/home/admin1/jgzj/.runtime/cloud-mapping/uploads`
- 下载目录：`/home/admin1/jgzj/.runtime/cloud-mapping/downloads`
- 日志目录：`/home/admin1/jgzj/.runtime/cloud-mapping/logs`
- 状态文件：`/home/admin1/jgzj/.runtime/cloud-mapping/mapping-state.json`

主要接口：

- `GET /api/cloud-mapping/status`
- `POST /api/cloud-mapping/login`
- `POST /api/cloud-mapping/logout`
- `POST /api/cloud-mapping/upload`
- `POST /api/cloud-mapping/start`
- `POST /api/cloud-mapping/clear-bag`
- `POST /api/cloud-mapping/clear-result`
- `GET /api/cloud-mapping/download`

## 7. 关键脚本和管理方式

项目内脚本：

- [scripts/start-site.sh](/home/admin1/jgzj/scripts/start-site.sh)
- [scripts/stop-site.sh](/home/admin1/jgzj/scripts/stop-site.sh)
- [scripts/restart-site-detached.sh](/home/admin1/jgzj/scripts/restart-site-detached.sh)
- [scripts/restart-frpc.sh](/home/admin1/jgzj/scripts/restart-frpc.sh)
- [scripts/start-port-pressure-monitor.sh](/home/admin1/jgzj/scripts/start-port-pressure-monitor.sh)
- [scripts/stop-port-pressure-monitor.sh](/home/admin1/jgzj/scripts/stop-port-pressure-monitor.sh)
- [scripts/port_pressure_monitor.py](/home/admin1/jgzj/scripts/port_pressure_monitor.py)
- [scripts/switch_jgzj_llm_chain.sh](/home/admin1/jgzj/scripts/switch_jgzj_llm_chain.sh)
- [scripts/switch_jgzj_intent_llm.sh](/home/admin1/jgzj/scripts/switch_jgzj_intent_llm.sh)

当前管理方式汇总：

| 组件 | 管理方式 |
|---|---|
| `8888` 官网后端 | `tmux:jgzj-site` |
| `8000` cloud-agent | `tmux:cloud-agent` |
| `frpc` | 独立进程 |
| `8794/8012` AI 检测栈 | `nohup setsid` |
| `8050/8051/8022/8024/8042/8043/18000/18001/18109` | `systemd` |

## 8. 常用排查命令

### 8.1 看站点

```bash
curl http://127.0.0.1:8888/healthz
curl http://127.0.0.1:8888/api/health
tail -n 80 /home/admin1/jgzj/.logs/web-backend.log
tmux attach -t jgzj-site
```

### 8.2 看云端运维链路

```bash
curl http://127.0.0.1:8000/healthz
curl http://127.0.0.1:8000/api/vehicles
tmux attach -t cloud-agent
```

### 8.3 看对话链路

```bash
curl http://127.0.0.1:8050/healthz
curl http://127.0.0.1:8022/healthz
curl http://127.0.0.1:8043/health/detail
sudo systemctl status jgzj-chat-bridge-8050-qwen35.service
sudo systemctl status jgzj-intent-v2-8022-failover.service
sudo systemctl status jgzj-llm-failover-8043.service
```

### 8.4 看 AI 检测链路

```bash
curl http://127.0.0.1:8794/healthz
curl http://127.0.0.1:8012/v1/models
pgrep -af 'qwen_ws_checker_service|vllm'
tail -n 80 /home/admin1/logs/qwen3_vl_2b_ws_checker/ws_8794.log
```

### 8.5 看 FRP

```bash
pgrep -af frpc
tail -n 80 /home/admin1/frp/frp_0.65.0_linux_amd64/frpc.log
curl http://idtrd.kmdns.net:7790/healthz
curl http://idtrd.kmdns.net:7791/healthz
```

### 8.6 看关键端口

```bash
ss -ltnp | rg ':(7788|7789|7790|7791|8000|8012|8022|8024|8042|8043|8050|8051|8794|8888|18000|18001|18109)\b'
```

## 9. 典型操作

### 9.1 重启官网

```bash
/home/admin1/jgzj/scripts/start-site.sh
```

### 9.2 停官网

```bash
/home/admin1/jgzj/scripts/stop-site.sh
```

### 9.3 重启 FRP

```bash
/home/admin1/jgzj/scripts/restart-frpc.sh
```

### 9.4 切 8050 到生产回滚链

```bash
/home/admin1/jgzj/scripts/switch_jgzj_llm_chain.sh qwen35
```

### 9.5 切 8022 到 failover

```bash
/home/admin1/jgzj/scripts/switch_jgzj_intent_llm.sh failover
```

### 9.6 启动端口监控

```bash
/home/admin1/jgzj/scripts/start-port-pressure-monitor.sh
```

产物会落在：

- 日志：`/home/admin1/jgzj/.logs/port-pressure-monitor.log`
- 输出：`/home/admin1/jgzj/.monitor/port-pressure`

## 10. 已知注意事项

- `jgzj` 仓库只承载网站和部分聚合后端，不承载 `cloud-agent`、`qwen-vl-infer`、`CloudVoice` 全部源码。
- `cloud-agent`、`qwen-vl-infer`、`CloudVoice`、`a100_tunnel` 都是仓库外依赖，改动前先确认是否要跨仓协同。
- `start-site.sh` 属于“重建再启动”，不要把它当无损秒级 restart。
- `runtime-control` 当前只覆盖 8 个关键节点，不代表整机所有服务。
- `frpc` 当前不是 systemd 管理，排查时要同时看父 bash 和真实 `frpc` 子进程。
- 文档不要继续扩散密码、token、私钥、cookie secret。当前仓库里已有本地默认值，不等于应该继续复制。

## 11. 推荐的下一个增强点

- 给 `8794` AI 检测栈补 systemd 管理，避免只靠 `nohup`。
- 给官网后端补更轻量的 restart 模式，减少每次 `npm ci` 带来的停机时间。
- 给 `cloud-agent`、`AI 检测`、`对话链路` 补统一的健康总览页，而不是只监控当前 8 个节点。
- 把外部依赖目录也各自补一份本地 handoff，避免只有 `jgzj` 仓库内有说明。

