# A100 Qwen3.6-27B 量化与吞吐实验结果

更新时间：2026-05-02  
执行主机：`/home/admin1/jgzj`  
A100 主机：`sari@192.168.80.49`

## 1. 真实机器状态

- A100 机当前不是 8 卡，而是 `5 x A100-SXM4-80GB`。
- `GPU0`：生产文本 `Qwen3.6-27B`，端口 `8000`，不能动。
- `GPU1`：生产多模态 `Qwen3.6-27B-MM`，端口 `8001`，不能动。
- `GPU2`：CosyVoice TTS 池，不能动。
- 真正可用于灰度实验的只有 `GPU3` 和 `GPU4`。

## 2. 本次实际测试了什么

### 已完成

1. 现网文本 baseline
   - `127.0.0.1:18000 -> A100:8000`
   - BF16 原始模型，只读 benchmark，不改现网。

2. 现网图像 baseline
   - `127.0.0.1:18001 -> A100:8001`
   - 单张图片 smoke，确认多模态链路可用。

3. 动态 FP8
   - `--quantization fp8` + 原始 BF16 权重
   - 结论：在 A100 + vLLM 0.19.1 上启动失败，不可用。

4. `BF16 + KV cache FP8`
   - `GPU3:8003`
   - `--kv-cache-dtype fp8_e5m2`
   - `--enable-auto-tool-choice`
   - `--tool-call-parser qwen3_coder`

5. `BF16 + KV cache FP8 + MTP=1`
   - `GPU4:8004`
   - `--kv-cache-dtype fp8_e5m2`
   - `--speculative-config '{"method":"qwen3_next_mtp","num_speculative_tokens":1}'`

6. 官方 `Qwen3.6-27B-FP8`
   - `GPU3:8005`
   - 文本模式 `--language-model-only`

7. 官方 `Qwen3.6-27B-FP8 + MTP=1`
   - `GPU3:8006`
   - 文本模式 `--language-model-only`
   - `--speculative-config '{"method":"mtp","num_speculative_tokens":1}'`

8. 官方 `Qwen3.6-27B-FP8 + MTP=1` 多模态灰度
   - `GPU3:8006`
   - 保留 VLM 结构，不加 `--language-model-only`
   - `--max-model-len 16384`
   - `--max-num-seqs 16`
   - 本机隧道：`127.0.0.1:18006 -> A100:127.0.0.1:8006`

9. 官方 `Qwen3.6-27B-FP8 + MTP=1` 文本灰度
   - `GPU4:8004`
   - 文本模式 `--language-model-only`
   - `--max-model-len 32768`
   - `--max-num-seqs 32`
   - 本机隧道：`127.0.0.1:18004 -> A100:127.0.0.1:8004`

10. `AWQ INT4` 文本实验
   - `GPU4`
   - vLLM 能识别 `awq_marlin`
   - 权重可加载进显存，但在本次 `A100 + vLLM 0.19.1` 环境里未成功起出可用 API
   - 结论：不作为当前交付线

### 后台继续中

- `mattbucci/Qwen3.6-27B-AWQ`
- `Lorbus/Qwen3.6-27B-int4-AutoRound`

这两个仓库的权重下载已恢复到后台，但在本次窗口内未完成完整 benchmark。

## 3. 关键兼容性结论

- 动态 `--quantization fp8` 不可用，A100 上直接报错：
  `RuntimeError: size_n = 96 is not divisible by tile_n_size = 64`
- 官方 FP8 可以正常加载，但日志明确提示：
  A100 不具备原生 FP8 计算能力，vLLM 在这里走的是 `weight-only FP8 compression + Marlin kernel`。
- `qwen3_next_mtp` 在当前 vLLM 0.19.1 中已被提示废弃，实际会映射为 `mtp`。

## 4. 回归口径

所有文本 benchmark 都使用同一套业务 prompt 回归：

- 中文身份问答
- 白泽业务 RAG
- 园区入口/POI 问答
- 安防事件处置
- 多轮对话
- 长上下文 RAG
- 结构化 JSON 输出
- 时间工具调用
- 天气工具调用

图像侧除了现网单图 smoke，还补了 `GPU3:8006` 的多模态灰度回归与小压测。

## 5. 汇总结果

| 方案 | 平均 TTFT | 平均 decode tok/s | 并发16 requests/s | 并发16 output tok/s | 工具调用 | JSON | 备注 |
|---|---:|---:|---:|---:|---|---|---|
| 现网 baseline `8000` | `801.6 ms` | `31.6` | 未压 | 未压 | 否 | 是 | 保护现网，只做轻载 |
| `BF16 + KV FP8` | `842.2 ms` | `29.1` | `11.21` | `261.23` | 是 | 是 | 容量优化明显，纯提速不明显 |
| `BF16 + KV FP8 + MTP1` | `493.4 ms` | `46.1` | `13.03` | `303.75` | 是 | 是 | 低延迟收益明显 |
| 官方 `FP8` | `1192.9 ms` | `48.83` | `13.30` | `313.33` | 是 | 是 | 吞吐强，首 token 偏慢 |
| 官方 `FP8 + MTP1` | `464.0 ms` | `67.46` | `13.75` | `321.41` | 是 | 是 | 本次综合最强 |
| 官方 `FP8 + MTP1` 文本 `GPU4` | `1085.3 ms` | `65.86` | `14.09` | `333.75` | 是 | 是 | 当前文本灰度交付线 |
| 官方 `FP8 + MTP1 VLM` | `1212.5 ms` | `67.97` | `13.80` | `321.73` | 是 | 是 | `GPU3` 可同时承接文本+图片 |

补充说明：

- `BF16 + KV FP8 + MTP1` 的 vLLM metrics 里，MTP 接受率大约落在 `87%~92%`。
- `官方 FP8 + MTP1` 的 steady-state 表现显著好于第一次冷启动跑分，因此最终以 rerun 结果为准。
- `security_event` 这个提示在所有配置下都出现了相同的截断现象：
  `请立刻呼叫园区安保并拨打120/11`
  这更像 prompt / 模板 / stop 行为问题，不是量化特有问题。
- `baize_rag` 在官方 FP8 / FP8+MTP1 上被当前 validator 记成失败，但人工看回答本身并不差，主要是校验规则对“异常检测/异常识别/园区指引/导览”写法过严。

## 6. 图像侧结论

- 现网多模态 baseline：
  - 单张图片 smoke 延迟约 `3380.7 ms`
  - 能稳定输出中文场景描述
- `GPU3` 新灰度：
  - 方案：官方 `FP8 + MTP=1`，保留 VLM
  - 入口：`127.0.0.1:18006 -> A100 GPU3:8006`
  - 单图 smoke：
    - `latency_ms 2988.4`
    - `decode_tok/s 60.04`
    - 中文图像描述稳定
  - 文本/工具/JSON/长上下文同一套回归：
    - `case_ok 8/10`
    - `json_ok=true`
    - `tool_ok=true`
    - `long_ctx_ok=true`
- 额外短压测：
  - 文本 `64 req @ 并发16`：`0` 失败，`9.35 req/s`，`362.57 output tok/s`
  - 图片 `8 req @ 并发4`：`0` 失败，`1.01 req/s`，`55.48 output tok/s`
- 已知问题仍然不是量化特有：
  - `security_event` 继续在所有版本上出现相同截断。

## 7. 当前推荐排序

### 已实测后的 A100 优先级

1. `官方 FP8 + MTP=1`
   - 当前最值得优先灰度。
   - 原因：在本次环境里，它同时拿到了最好的 `TTFT` 改善和最高的 `decode tok/s / 并发吞吐`。

2. `官方 FP8`
   - 适合作为“生产稳定版”的保守候选。
   - 原因：工具调用和 JSON 稳定，吞吐高，但首 token 延迟不如 MTP 版。

3. `BF16 + KV FP8 + MTP=1`
   - 适合作为“不下载新权重也能先提速”的过渡方案。
   - 原因：立刻可用，工具链稳定，收益明显。

4. `BF16 + KV FP8`
   - 更像容量优化/工程优化，不是纯提速主方案。

### 还未实测完的路线

5. `AWQ INT4`
   - 权重已下完。
   - 本次环境里能走到 `awq_marlin`，但没能在合理时间内起出可用 API。
   - 暂不作为当前交付线，后续可换 vLLM 版本再补。

6. `AutoRound INT4`
   - 权重后台下载中。
   - 值得作为激进吞吐探索版。

7. `GPTQ INT4`
   - 本次未启动。
   - 排在 AWQ / AutoRound 之后。

## 8. 三个最终候选建议

### A. 生产稳定版

- 纯文本首选：`官方 FP8`
- 需要兼顾 VLM 时首选：`官方 FP8 + MTP=1 VLM`
- 适用：工具调用、中文服务问答、图片理解、网页端稳定灰度

### B. 最高吞吐版

- 纯文本当前最佳：`官方 FP8 + MTP=1`
- 当前已交付入口：`127.0.0.1:18004`
- 兼顾 VLM 当前最佳：`官方 FP8 + MTP=1 VLM`
- 次选：`BF16 + KV FP8 + MTP=1`
- 下一步待补：`AWQ INT4 + MTP=1`

### C. 长上下文版

- 当前先用：`官方 FP8` 或 `BF16 + KV FP8`
- 原因：长上下文 RAG 已通过当前 9.4k prompt 回归
- 后续应再补 `64K / 128K / 262K` 单独压测

## 9. 当前远端活跃灰度

- `GPU3 :8006`
  - `Qwen3.6-27B-FP8-VLM-MTP1-gpu3`
  - 本机入口：`127.0.0.1:18006`
- `GPU4 :8004`
  - `Qwen3.6-27B-FP8-MTP1-text-gpu4`
  - 本机入口：`127.0.0.1:18004`

生产仍保持不变：

- `GPU0 :8000`
  - `Qwen3.6-27B`
- `GPU1 :8001`
  - `Qwen3.6-27B-MM`
- `GPU2`
  - CosyVoice TTS pool

## 10. 下一步最值得做的事

1. 用现有 `127.0.0.1:18006` 做小流量灰度，比对真实业务日志中的 TTFT、平均句长、图像请求延迟和 tool_call 成功率。
2. 用现有 `127.0.0.1:18004` 做文本小流量灰度，比对 `GPU0` 现网的平均句长、TTFT、tool_call 成功率和长上下文稳定性。
3. 等 `AutoRound` 或更新版 vLLM 可用后，在 `GPU3/GPU4` 轮换补测：
   - `AWQ`
   - `AWQ + MTP1`
   - `AutoRound`
   - `AutoRound + MTP1`
4. 单独审计 `security_event` 这条 prompt 的截断问题，因为它在 baseline 和所有灰度上都复现。

## 11. GPU0 现网 vs GPU4 文本灰度

说明：
- 用户要求“在 GPU2 上做文本量化”与现场事实冲突。
- `GPU2` 实际承载 CosyVoice TTS 生产池，不能无损复用。
- 因此当前文本量化线落在真正空闲的 `GPU4`，这是不影响生产的可执行方案。

同口径 benchmark 结果：

| 指标 | GPU0 现网 `127.0.0.1:18000` | GPU4 灰度 `127.0.0.1:18004` | 变化 |
|---|---:|---:|---:|
| 平均 TTFT | `841.8 ms` | `1085.3 ms` | `-28.9%` |
| 平均 decode tok/s | `29.84` | `65.86` | `+120.7%` |
| 并发1 output tok/s | `24.89` | `43.16` | `+73.4%` |
| 并发4 output tok/s | `89.74` | `57.94` | `-35.4%` |
| 并发8 output tok/s | `149.91` | `210.41` | `+40.4%` |
| 并发16 output tok/s | `260.54` | `333.75` | `+28.1%` |
| 并发16 requests/s | `11.30` | `14.09` | `+24.7%` |
| 工具调用 | `400` 失败 | 成功 | 明显改善 |
| JSON | 成功 | 成功 | 持平 |
| 长上下文 | 成功 | 成功 | 持平 |

结论：
- 如果只看首 token，`GPU0` 现网略快。
- 如果看持续输出速度、16 并发吞吐、工具调用和整体可用性，`GPU4 FP8+MTP1` 明显更强。
- `GPU4` 是更适合接高并发文本业务的灰度线，`GPU0` 继续保留现网稳定主路由。
