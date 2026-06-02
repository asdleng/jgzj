# A100 Qwen3.6-27B 只读架构与优化笔记

更新时间：2026-05-02  
范围：只描述当前这台 4090 服务器与 A100 上 `Qwen3.6-27B` 相关的实际链路、配置入口、只读排查方法和后续优化方向。  
约束：本文不包含任何“重启/切换/改配置”的执行步骤，只用于阅读、定位和制定后续优化方案。

## 1. 先看哪几份文档

主文档有两份：

1. `/home/admin1/JGZJ_IDTRD_HANDOFF.md`
   - 覆盖整台服务器对外入口、端口映射、7790 链路、A100 tunnel、TTS 池、FRP。
   - 适合先看整机和公网入口。

2. `/home/admin1/jgzj/docs/JGZJ_SERVER_HANDOFF.md`
   - 只聚焦 `jgzj` 官网和其依赖服务。
   - 适合看 7791 官网、7790 对话、Qwen3.6 文本/多模态入口、runtime control。

如果要继续往代码里看，优先看这些文件：

- `/home/admin1/jgzj/backend/server.js`
- `/home/admin1/CloudVoice/multi_car_asr_demo/intent_chat_tts_bridge.py`
- `/home/admin1/CloudVoice/multi_car_asr_demo/ai2_backend/intent_v2_server.py`
- `/home/admin1/CloudVoice/multi_car_asr_demo/ai2_backend/intent_v2/core.py`
- `/home/admin1/CloudVoice/multi_car_asr_demo/vllm_chat_failover_server.py`
- `/etc/systemd/system/jgzj-qwen36-text-tunnel.service`
- `/home/admin1/a100_tunnel/start_qwen36_local_tunnel.sh`

## 2. 当前实际链路

### 2.1 官网直接调用 Qwen3.6 文本能力

链路：

`7791 -> 8888 /api/qwen36-chat -> 127.0.0.1:18000/v1 -> A100 127.0.0.1:8000`

说明：

- `8888` 是官网 Node/Express 服务。
- `18000` 不是模型本体，而是本机到 A100 的 SSH 本地隧道。
- 真正的 `Qwen3.6-27B` 跑在 A100 `192.168.80.49` 的 `127.0.0.1:8000`。

### 2.2 7790 云端对话主链

链路：

`7790 -> 8050 -> 8022 -> 8043 -> 18000 -> A100 8000`

分层含义：

- `8050`：bridge，承接网页/车端的对话入口，并串上 TTS。
- `8022`：intent_v2，负责意图、RAG、工具、对话策略。
- `8043`：failover chat server，负责发 OpenAI/vLLM 格式请求到实际 LLM。
- `18000`：A100 文本模型 tunnel。
- `A100:8000`：`Qwen3.6-27B` vLLM 服务本体。

### 2.3 官网多模态链路

链路：

`7791 -> 8888 /api/qwen36-mm-check -> 127.0.0.1:18001/v1 -> A100 127.0.0.1:8001`

## 3. 本机侧的关键入口

### 3.1 tunnel 服务

文本 tunnel：

- 服务文件：`/etc/systemd/system/jgzj-qwen36-text-tunnel.service`
- 本地端口：`127.0.0.1:18000`
- 远端端口：`127.0.0.1:8000`

多模态 tunnel：

- 服务文件：`/etc/systemd/system/jgzj-qwen36-mm-tunnel.service`
- 本地端口：`127.0.0.1:18001`
- 远端端口：`127.0.0.1:8001`

隧道脚本：

- `/home/admin1/a100_tunnel/start_qwen36_local_tunnel.sh`

脚本本质只是：

- 用 `ssh -L 127.0.0.1:18000 -> 127.0.0.1:8000`
- 用 `ssh -L 127.0.0.1:18001 -> 127.0.0.1:8001`

### 3.2 官网后端入口

`/home/admin1/jgzj/backend/server.js` 里当前固定了：

- `QWEN36_BASE_URL` 默认 `http://127.0.0.1:18000/v1`
- `QWEN36_MODEL` 默认 `Qwen3.6-27B`
- `QWEN36_MM_BASE_URL` 默认 `http://127.0.0.1:18001/v1`

也就是说，官网不会直接 SSH 到 A100，而是始终经由本机 tunnel。

### 3.3 8043 failover 对 A100 的请求形态

`/home/admin1/CloudVoice/multi_car_asr_demo/vllm_chat_failover_server.py`

当前要点：

- 会给上游发 OpenAI chat 格式请求。
- `chat_template_kwargs` 里已经带：
  - `enable_thinking`
  - `preserve_thinking`
- 如果 `thinking` 打开，会把 reasoning 和 final answer 分开流出来。

这说明当前“推理能力表现”不只是 A100 模型本身问题，还受 8043 的请求模板和 8022 的预算控制影响。

### 3.4 8022 intent_v2 对 token 预算的控制

`/home/admin1/CloudVoice/multi_car_asr_demo/ai2_backend/intent_v2/core.py`

当前要点：

- 普通回答、RAG 回答、长文回答会走不同的 `llm_max_new_tokens` 策略。
- 如果 `enable_thinking` 为真，当前代码会把生成预算至少抬到 `2048`。

这层非常关键，因为之前 thinking 被截断并兜底成“抱歉，我现在无法回答这个问题”，问题并不在 A100 本体，而在整条链给 answer 留下的预算不够。

## 4. A100 当前实际运行状态

### 4.1 当前生产文本模型

通过只读查看 A100 上的进程，当前生产文本服务是：

- 远端 tmux：`qwen36vllm`
- 监听：`127.0.0.1:8000`
- 模型：`/home/sari/models/Qwen3.6-27B`
- 服务名：`Qwen3.6-27B`

当前可见启动参数：

- `--reasoning-parser qwen3`
- `--language-model-only`
- `--max-model-len 32768`
- `--gpu-memory-utilization 0.92`
- `--max-num-seqs 16`

### 4.2 当前生产多模态模型

通过只读查看 A100 上的进程，当前多模态服务是：

- 远端 tmux：`qwen36mmvllm`
- 监听：`127.0.0.1:8001`
- 模型：`/home/sari/models/Qwen3.6-27B`
- 服务名：`Qwen3.6-27B-MM`

当前可见启动参数：

- `--reasoning-parser qwen3`
- `--max-model-len 16384`
- `--gpu-memory-utilization 0.90`
- `--max-num-seqs 8`

### 4.3 现有灰度/实验脚本

本机目录里已经有一个未接入生产链的实验脚本：

- `/home/admin1/a100_tunnel/start_qwen36_kvfp8_gray_vllm.sh`

它对应的是一条潜在灰度模型路径：

- 远端端口：`8003`
- 本地建议 tunnel：`18003`
- 服务名：`Qwen3.6-27B-KVFP8-gray`
- 关键参数：
  - `--kv-cache-dtype fp8_e5m2`
  - `--max-model-len 16384`
  - `--max-num-seqs 32`

这说明系统里已经存在“给 Qwen3.6 做单独灰度实验”的技术入口，只是当前生产 `7790/7791` 还没有接它。

## 5. 只读检查时，优先区分哪三层问题

后续如果要优化 `Qwen3.6-27B` 的推理能力，先不要把所有问题都归因给 A100 模型本体。至少要分三层看：

### 5.1 模型层

看 A100 上的 vLLM 和模型本身：

- 模型版本是否一致
- reasoning parser 是否匹配
- 上下文长度和并发压榨是否影响答题稳定性
- A100 上是否存在更合适的灰度实例

### 5.2 中间服务层

看 `8043`、`8022`：

- thinking 是否被保留
- answer 是否被截断
- token 预算是否被 intent/RAG/longform 分支吃掉
- 是否存在 fallback 到通用兜底文案

### 5.3 产品路由层

看 `8888` 和 `8050`：

- 是走官网直连 Qwen3.6，还是走 7790 全链路
- 是否带了 `enable_thinking`
- 是否需要语音、TTS、工具、RAG

很多“Qwen3.6 推理变差”表面现象，实际可能出在 8022/8043，而不是 A100 vLLM。

## 6. 只读结论：当前最值得优化的 5 个方向

这里只记结论，不做变更。

### 方向 1：把“模型能力问题”和“链路策略问题”拆开测

建议后续统一用同一批题，同时测三条路径：

1. `18000` 直接问模型
2. `8043` 经过 failover 问模型
3. `7790` 全链路问模型

如果三者表现不同，优先查 8043 / 8022，不要先动 A100 模型。

### 方向 2：为 reasoning 任务建立固定评测集

当前没有看到一套固定评测题。后续如果要“不断优化推理能力”，至少要覆盖：

- 算术与数论
- 长链条中文推理
- 常识与历史问答
- 工具/RAG 干扰下的最终回答稳定性
- thinking 开/关 两种模式

否则只能凭体感调。

### 方向 3：把 A100 灰度实验链真正独立出来

当前已经有 `8003 / 18003 / KV FP8 gray` 的脚本入口，但生产链还没有可观测的灰度对比。

后续应考虑：

- 不动生产 `18000`
- 单独拉一条只读灰度比对链
- 让 `8042/8051` 或网页内部测试入口专门打灰度链

这样才适合持续优化而不影响线上对话。

### 方向 4：单独审计 8022 的 prompt 和 token 预算

从现在代码看，thinking 质量不是纯模型问题，`core.py` 里对：

- search
- longform
- local RAG
- thinking

都有不同预算策略。  
后续如果 reasoning 还“不够聪明”，必须连同：

- prompt 构造
- RAG 拼接长度
- search 证据长度
- 预算分配

一起看。

### 方向 5：把 A100 的 serving 参数与效果做 A/B 记录

当前线上文本服务是：

- `max_model_len=32768`
- `gpu_memory_utilization=0.92`
- `max_num_seqs=16`

实验脚本是：

- `max_model_len=16384`
- `max_num_seqs=32`
- `kv-cache-dtype=fp8_e5m2`

这两类配置更像“吞吐/稳定性/延迟”的权衡，不应靠记忆拍脑袋。  
后续需要把每次实验的：

- 配置
- 吞吐
- 首 token 延迟
- thinking 完整度
- 最终回答质量

做成固定表格。

## 7. 只读查看入口

### 7.1 本机

推荐先看：

- `/home/admin1/JGZJ_IDTRD_HANDOFF.md`
- `/home/admin1/jgzj/docs/JGZJ_SERVER_HANDOFF.md`
- `/home/admin1/jgzj/backend/server.js`
- `/home/admin1/CloudVoice/multi_car_asr_demo/vllm_chat_failover_server.py`
- `/home/admin1/CloudVoice/multi_car_asr_demo/ai2_backend/intent_v2/core.py`

### 7.2 A100

当前有一个单独查看会话可用时，可从本机附加：

```bash
tmux attach -t a100-qwen36-opt
```

只读检查常用命令：

```bash
hostname
pwd
tmux ls
nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader
ps -ef | grep -E 'vllm|Qwen3.6' | grep -v grep
```

如果需要直接只读进 A100：

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i /home/admin1/a100_tunnel/jgzj_qwen36_proxy_ed25519 sari@192.168.80.49
```

## 8. 当前结论

这台服务器上关于“服务器架构说明”和 “A100 上 Qwen3.6-27B 当前真实接法”的资料，并不是缺失，而是分散在：

- 整机 handoff
- `jgzj` handoff
- 官网后端代码
- 7790 对话链代码
- A100 tunnel/service 文件

如果下一步目标是“持续优化 Qwen3.6-27B 的推理能力”，最合理的顺序不是直接改 A100，而是：

1. 先固定评测题；
2. 再拆开 `18000 / 8043 / 7790` 三层测；
3. 然后用灰度链做 A/B；
4. 最后才决定是改 A100 serving 参数，还是改 8022/8043 的 reasoning 策略。
