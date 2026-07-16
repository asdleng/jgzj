# 烟雾火焰网络候选采集与 Qwen3.6-27B 预标

这套脚本只生成候选审核集，不直接生成可训练数据。两个阶段都会写入
`training_eligible=false`，避免网页搜索结果或单模型伪标签污染生产训练集。

## 1. 采集

默认使用 Wikimedia Commons API，并可追加 Openverse API。Openverse 用来扩展到 Flickr、NASA、Geograph 等开放图库，同时返回图片、作者、原始来源页和许可证；两者进入同一授权白名单和去重链路。
当前服务器到 Wikimedia 出口超时，因此也支持人工准备的 JSON/JSONL URL 清单；清单
必须为每张图提供许可证。允许的默认许可证为 Public Domain、CC0、CC BY、CC BY-SA。

```bash
HTTP_PROXY=http://127.0.0.1:7897 \
HTTPS_PROXY=http://127.0.0.1:7897 \
ALL_PROXY=http://127.0.0.1:7897 \
python3 scripts/crawl_fire_smoke_candidates.py \
  --output .runtime/yolo_loop/datasets/fire_smoke_web_candidates_v1 \
  --commons-config config/wikimedia_fire_smoke_queries.json \
  --max-images 500
```

服务器 Mihomo 在 `127.0.0.1:7897`，但终端默认没有代理环境变量。Commons 图片使用
`commons.wikimedia.org/w/thumb.php` 官方接口下载；直接访问 `upload.wikimedia.org` 在当前代理
出口会收到 429。均衡小批量验证可改用 `config/wikimedia_fire_smoke_queries_pilot.json`。

URL 清单格式：

```json
{
  "items": [{
    "url": "https://example.org/image.jpg",
    "source_page_url": "https://example.org/image-page",
    "license": "CC BY 4.0",
    "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "author": "author name",
    "query": "vehicle fire",
    "bucket": "fire_positive"
  }]
}
```

采集器会检查 MIME、尺寸、最大文件大小、图片可解码性、SHA256 和 dHash 近重复，
并保留完整来源元数据。搜索词仅作为采集提示，明确不是标签。

## 2. Qwen3.6-27B 预标和复核

服务器现有模型入口：

```text
http://127.0.0.1:18016/v1/chat/completions
model=Qwen3.6-27B-Labeler
```

```bash
python3 scripts/label_fire_smoke_candidates_qwen.py \
  --dataset .runtime/yolo_loop/datasets/fire_smoke_web_candidates_v1 \
  --max-images 200
```

第一遍只检测 `fire/smoke`，第二遍用同一张原图独立复核并可修正框。脚本还会过滤
低分框以及 fog、mist、steam、cloud、dust、haze、glare、红色设备和灯光等高风险
误检证据。输出包括：

- `qwen_labels/<sha-prefix>/<sha>.json`：完整 prompt 版本、原始返回、解析框和复核结果。
- `labels/review/*.txt`：仅供人工审核的 YOLO txt。
- `qwen_review_manifest.jsonl`：审核队列索引。
- `dataset_summary.json` 与 `training_guard.json`：固定禁止自动训练。

同一 Qwen 模型的二次复核不能替代人工。建议按 `正样本 100% + hard negative 20%`
抽检；只有人工明确批准的记录才能导出到新的 train/val/test 数据集，而且必须按来源
和近重复组切分，不能随机逐图切分。

任何从 `hard_negative_*` bucket 得到的正框都会被确定性转入 `needs_human`，不会写入审核
YOLO 标签；模型声称 positive 但没有通过严格框过滤的记录同样转人工。

## 3. 测试

```bash
python3 scripts/test_fire_smoke_web_pipeline.py
```
