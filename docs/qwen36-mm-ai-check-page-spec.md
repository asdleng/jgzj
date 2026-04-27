# Qwen3.6 27B 多模态 AI 检测页接入说明

更新时间：2026-04-23

## 当前链路

`jgzj` 网页当前已经建立到 A100 文本服务的 tunnel：

```text
本机 127.0.0.1:18000 -> A100 192.168.80.49:127.0.0.1:8000
```

对应脚本：

```bash
/home/admin1/a100_tunnel/start_qwen36_local_tunnel.sh
```

官网后端默认读取：

```text
QWEN36_BASE_URL=http://127.0.0.1:18000/v1
QWEN36_MODEL=Qwen3.6-27B
```

当前 `/api/qwen36-health` 正常，说明 `jgzj` 的 Qwen3.6 文本对话链路已通。

多模态服务在 A100 的 `127.0.0.1:8001`，当前本机已建立 systemd 管理的长期 tunnel：

```text
本机 127.0.0.1:18001 -> A100 192.168.80.49:127.0.0.1:8001
```

systemd 服务：

```bash
sudo systemctl status jgzj-qwen36-text-tunnel.service
sudo systemctl status jgzj-qwen36-mm-tunnel.service
```

## A100 端服务

文本服务：

```text
tmux: qwen36vllm
endpoint: 127.0.0.1:8000/v1
model: Qwen3.6-27B
GPU: 0
启动参数包含 --language-model-only
max_model_len: 32768
```

多模态服务：

```text
tmux: qwen36mmvllm
endpoint: 127.0.0.1:8001/v1
model: Qwen3.6-27B-MM
GPU: 1
max_model_len: 16384
```

Hugging Face 模型页说明 Qwen3.6-27B 是 `Image-Text-to-Text`，类型是带 Vision Encoder 的因果语言模型，支持 text、image、video 的 OpenAI-compatible Chat Completions API。vLLM 推荐版本为 `vllm>=0.19.0`，当前 A100 为 `vllm 0.19.1`，版本匹配。

参考文档：https://huggingface.co/Qwen/Qwen3.6-27B

## 图片加文字输入格式

8001 使用 OpenAI 兼容接口：

```text
POST /v1/chat/completions
Content-Type: application/json
```

核心请求结构：

```json
{
  "model": "Qwen3.6-27B-MM",
  "messages": [
    {
      "role": "system",
      "content": "你是面向园区、车端和工业场景的AI视觉检测助手。只根据图片可见信息回答，不确定就写不确定。"
    },
    {
      "role": "user",
      "content": [
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,...",
            "detail": "auto"
          }
        },
        {
          "type": "text",
          "text": "请检测这张图片。输出JSON，字段包括：scene、visible_objects、abnormal_findings、risk_level、confidence、summary。不要输出Markdown。"
        }
      ]
    }
  ],
  "max_tokens": 512,
  "temperature": 0.2,
  "top_p": 0.8,
  "top_k": 20,
  "presence_penalty": 1.5,
  "stream": false,
  "chat_template_kwargs": {
    "enable_thinking": false
  }
}
```

`image_url.url` 可以是公网图片 URL，也可以是 `data:image/jpeg;base64,...`。网页上传图片时，建议由后端接收图片并转成 base64 data URL，再转发到 A100，避免浏览器直接暴露 A100 或 tunnel 地址。

## 常用参数

必须字段：

```text
model
messages
messages[].role
messages[].content
```

多模态 content：

```text
{ "type": "text", "text": "..." }
{ "type": "image_url", "image_url": { "url": "...", "detail": "auto|low|high" } }
{ "type": "video_url", "video_url": { "url": "..." } }
```

生成参数：

```text
max_tokens 或 max_completion_tokens
temperature
top_p
top_k
min_p
presence_penalty
frequency_penalty
repetition_penalty
stop
seed
stream
response_format
```

Qwen/vLLM 扩展参数：

```text
chat_template_kwargs.enable_thinking
chat_template_kwargs.preserve_thinking
mm_processor_kwargs
media_io_kwargs
include_reasoning
thinking_token_budget
```

当前不要使用 `thinking_token_budget`：A100 日志显示，未配置 `--reasoning-config` 时该字段会触发 400。

推荐 AI 检测页用非 thinking 模式：

```json
{
  "temperature": 0.2,
  "top_p": 0.8,
  "top_k": 20,
  "presence_penalty": 1.5,
  "chat_template_kwargs": { "enable_thinking": false }
}
```

## 本次测试

测试图片：

```text
/home/admin1/jgzj/sucai/微信图片_20260416164022_544_458.jpg
```

测试方式：将图片转为 base64 data URL，发送到 A100 `8001` 的 `Qwen3.6-27B-MM`。

模型返回：

```json
{
  "scene": "城市商业步行街",
  "visible_objects": [
    "应急宣传服务机器人",
    "行人",
    "红灯笼",
    "商铺",
    "树木",
    "电动车"
  ],
  "abnormal_findings": "未发现明显异常或安全隐患。",
  "risk_level": "低风险",
  "confidence": 0.95,
  "summary": "图片显示一台南山应急宣传服务机器人在商业步行街上正常运行，周围有行人和商铺，环境秩序良好，无异常情况。"
}
```

结论：8001 确认支持图片加文字输入，适合做 AI 检测页的“上传图片 + 检测提示词 + 结构化结果”方案。

## 建议网页方案

AI 检测页建议做成一个实际可操作面板：

```text
左侧：图片输入区
- 上传图片
- 拖拽图片
- 使用示例图片
- 图片预览、文件名、尺寸、大小

右侧：检测配置
- 检测目标输入框，例如“检查是否有人员聚集、车辆异常、道路占用、设备状态异常”
- 场景类型选择：园区巡检 / 车端视角 / 商业街区 / 工业设备 / 通用
- 输出格式选择：摘要 / JSON / 表格
- 开始检测按钮

底部或右侧结果区：
- 风险等级
- 置信度
- 可见对象列表
- 异常发现
- 处理建议
- 原始 JSON 折叠展示
```

后端建议新增一个专门接口：

```text
POST /api/qwen36-mm-check
```

浏览器只提交：

```text
image: multipart file
prompt: 用户检测需求
mode: 场景类型
```

后端负责：

```text
1. 校验图片大小和类型
2. 转 base64 data URL
3. 拼 system prompt 和 user content
4. 请求 http://127.0.0.1:18001/v1/chat/completions
5. 返回结构化 JSON 给前端
```

前端不应该直接请求 A100；统一走 `jgzj` 后端代理。
