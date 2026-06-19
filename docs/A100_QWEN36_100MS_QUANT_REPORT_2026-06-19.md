# Qwen3.6-27B-MM 单图量化/加速实验

日期：2026-06-19  
主机：A100 `sari@192.168.80.49`，经 `ts-server` 进入  
目标：把当前 Qwen3.6-27B-MM 单图链路从 500ms+ 压到 100ms，重点看量化/MTP 方案

## 结论

1. 100ms 目标在 **Qwen3.6-27B-MM 单图链路** 上没有被量化打穿。
   - 纯文本 27B 单 token 下限：约 86-94ms。
   - 加一张图，即使把视觉输入压到 36-73 prompt tokens，最佳也约 151ms。
   - 因此 100ms 以下必须换链路：小 VLM / detector 先跑，27B 只做低频复核或复杂样本。

2. A100 上唯一有速度收益的 27B 量化组合是：
   - `Qwen3.6-27B-FP8 + MTP2 + mm_processor_kwargs.max_pixels + 极短输出`
   - 最佳实测：
     - 单 token：约 151ms
     - 极简 16-token JSON：约 329-339ms
     - 完整 crowd JSON 64 tokens：约 805ms，低延迟配置约 780ms

3. INT4 不是本机提速解法。
   - AutoRound INT4 可启动，但慢于 FP8+MTP2。
   - AWQ INT4 可启动但输出全是 `!`，且日志大量缺失量化参数，判定不可用。

4. 当前业务代码还有可优化参数，但只能把秒级压到几百毫秒，不能把 27B VLM 压到 100ms。
   - `backend/park-pcm.js` 当前 `max_tokens: 900` 偏大。
   - 应改为 `max_tokens: 64` 或更小，并加：
     - `mm_processor_kwargs: {"max_pixels": 12544}` 或按准确率调到 `25088/50176`
   - 但完整 crowd schema 仍约 0.8s 级别。

## 现有硬件/服务状态

实测 A100 是 6 张 `NVIDIA A100-SXM4-80GB`。

生产服务：

- GPU0：`Qwen3.6-27B` 文本，端口 `8000`
- GPU1：`Qwen3.6-27B-MM` 多模态，端口 `8001`
- GPU2：A100 TTS pool，端口 `8909`

实验服务：

- GPU5：`Qwen3.6-27B-FP8-VLM-MTP2-gpu5`，端口 `8015`
- GPU3/GPU4 已释放

## 实测数据

测试图：`094557_BIT-0013_camera1_fffd12cb.jpg`，约 633KB，真实巡逻图片。

### 原图，不降视觉 token

| 方案 | prompt | 输出上限 | prompt tokens | 平均延迟 |
|---|---:|---:|---:|---:|
| BF16 VLM | one-token | 1 | 2068 | 237ms |
| BF16 VLM | tiny JSON | 16 | 2075 | 768ms |
| BF16 VLM | crowd JSON | 64 | 2240 | 2537ms |
| FP8+MTP1 | one-token | 1 | 2068 | 592ms |
| FP8+MTP1 | tiny JSON | 16 | 2075 | 821ms |
| FP8+MTP1 | crowd JSON | 64 | 2240 | 1641ms |
| FP8+MTP2 | one-token | 1 | 2068 | 568ms |
| FP8+MTP2 | tiny JSON | 16 | 2075 | 752ms |
| FP8+MTP2 | crowd JSON | 64 | 2240 | 1394ms |

说明：A100 没有原生 FP8 计算，vLLM 日志显示走 FP8 weight-only + Marlin。原图单 token 时 FP8 反而慢，长输出时 MTP2 才明显收益。

### 加 `mm_processor_kwargs.max_pixels`

`image_url.max_pixels` 在当前 vLLM OpenAI API 入口里被忽略；`mm_processor_kwargs.max_pixels` 有效。

| 方案 | max_pixels | prompt | 输出上限 | prompt tokens | 平均延迟 |
|---|---:|---|---:|---:|---:|
| BF16 | 50176 | one-token | 1 | 73 | 200ms |
| BF16 | 25088 | one-token | 1 | 46 | 201ms |
| BF16 | 12544 | one-token | 1 | 36 | 200ms |
| FP8+MTP2 | 50176 | one-token | 1 | 73 | 152ms |
| FP8+MTP2 | 25088 | one-token | 1 | 46 | 151ms |
| FP8+MTP2 | 12544 | one-token | 1 | 36 | 152ms |
| FP8+MTP2 | 50176 | tiny JSON | 16 | 80 | 333ms |
| FP8+MTP2 | 25088 | tiny JSON | 16 | 53 | 335ms |
| FP8+MTP2 | 12544 | tiny JSON | 16 | 43 | 339ms |
| FP8+MTP2 | 50176 | crowd JSON | 64 | 245 | 955ms |
| FP8+MTP2 | 25088 | crowd JSON | 64 | 218 | 891ms |
| FP8+MTP2 | 12544 | crowd JSON | 64 | 208 | 805ms |

低延迟服务参数：

- `max_model_len=4096`
- `max_num_seqs=4`
- 不开 prefix caching

结果没有破 100ms：

| 方案 | max_pixels | prompt | 输出上限 | 平均延迟 |
|---|---:|---|---:|---:|
| FP8+MTP2 lowlat | 50176 | one-token | 1 | 175ms |
| FP8+MTP2 lowlat | 12544 | one-token | 1 | 201ms |
| FP8+MTP2 lowlat | 12544 | tiny JSON | 16 | 329ms |
| FP8+MTP2 lowlat | 12544 | crowd JSON | 64 | 780ms |

### INT4

| 方案 | 状态 | 速度 | 正确性 |
|---|---|---:|---|
| AutoRound INT4 | 可启动，vLLM 识别 `quantization=inc` | one-token 187-199ms；tiny JSON 391-394ms；crowd JSON 1068ms | 输出正常，但慢于 FP8+MTP2 |
| AWQ INT4 | 可启动 | one-token 181-193ms；tiny JSON 458ms；crowd JSON 1350ms | 输出全是 `!`，日志有大量 `linear_attn.* qweight/qzeros/scales not found`，不可用 |

### 现网与小模型参考

现网 `18001 -> GPU1:8001`，加 `mm_processor_kwargs.max_pixels=12544` 后：

| prompt | 输出上限 | p50 延迟 |
|---|---:|---:|
| one-token | 1 | 345ms |
| tiny JSON | 16 | 877ms |
| crowd JSON | 64 | 2697ms |

本机已有 `qwen3-vl-2b-checker`：

| prompt | 输出上限 | p50 延迟 |
|---|---:|---:|
| one-token | 1 | 53ms |
| tiny JSON | 16 | 109ms |
| crowd JSON | 64 | 326ms |

这说明如果必须贴近 100ms，路线应该是小 VLM/detector 承担高频判断，27B 做复核。

## 推荐方案

### 方案 A：保留 27B，尽量快

启动：

```bash
CUDA_VISIBLE_DEVICES=5 /home/sari/.venvs/vllm-qwen36/bin/vllm serve /home/sari/models/Qwen3.6-27B-FP8 \
  --host 127.0.0.1 \
  --port 8015 \
  --served-model-name Qwen3.6-27B-FP8-VLM-MTP2-gpu5 \
  --reasoning-parser qwen3 \
  --max-model-len 16384 \
  --gpu-memory-utilization 0.92 \
  --max-num-seqs 16 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --speculative-config '{"method":"mtp","num_speculative_tokens":2}'
```

请求参数：

```json
{
  "max_tokens": 64,
  "temperature": 0,
  "chat_template_kwargs": {"enable_thinking": false},
  "mm_processor_kwargs": {"max_pixels": 12544}
}
```

预期：完整 crowd schema 约 0.8s；极简 JSON 约 0.33s；单 token 约 0.15s。

### 方案 B：100ms 级链路

不建议让 27B 每图全量分析。推荐两级：

1. 高频路径：YOLO/RT-DETR/轻量 person detector 或 `qwen3-vl-2b-checker`
   - 只输出 `people_count/confidence/risk_flag`
   - 目标 50-120ms
2. 低频复核：Qwen3.6-27B-FP8+MTP2
   - 只处理“有人/风险/低置信度/抽样复核”
   - 目标 0.3-0.8s，但请求量降到小比例

### 方案 C：业务侧立刻改

`backend/park-pcm.js` 的 `analyzeCrowdFrame` 里：

- `max_tokens: 900` 改为 `64` 或 `96`
- 增加 `mm_processor_kwargs: { max_pixels: 12544 }`
- 如果只是人数，改极简 schema，不要让模型生成全量 `age_groups/mobility/risk/note`

这能明显降延迟，但不能保证 100ms。

## 事故与恢复

实验清理时一次嵌套 SSH kill 命令里 `$p` 被提前展开，误杀了 A100 上的生产 vLLM/TTS 进程。已立即恢复：

- `09_a100_qwen36_llm_8000.sh restart`：GPU0 文本 ready
- `10_a100_qwen36_vlm_8001.sh restart`：GPU1 多模态 ready
- `11_a100_tts_pool_8909.sh restart`：GPU2 TTS pool ready，18109 tunnel ready

后续避免用嵌套引号组合 `ss | sed | xargs kill`，只使用明确的服务脚本或 `fuser -k <port>/tcp` 清理单个本机端口。
