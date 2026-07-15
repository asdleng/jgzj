# 弱事件网络候选数据

## 目标

补充现有车端闭环中不足或质量不稳定的四类数据：

- `fishing_rod`：钓鱼竿正样本，以及手杖、登山杖、雨伞、栏杆难负样本。
- `stall`：临时摊位正样本，以及固定岗亭、售货机、安检帐篷、公交站难负样本。
- `pet`：室外小目标猫狗，以及动物雕塑、玩偶难负样本。
- `bottle/box/paper/bag`：地面废弃物，以及垃圾桶、储物箱、道路标线、交通标志难负样本。

通用猫狗公开数据已足够，本任务只补接近车端视角的样本和难负样本。

## 数据边界

- 数据源仅使用带可追溯授权信息的 Wikimedia Commons 图片。
- 搜索词和目录名不是标签，图片必须经过两遍独立 Qwen 复核。
- 所有图片、标签、清单和汇总始终写入 `training_eligible=false`。
- 难负样本桶中发现的正目标进入 `needs_human`，不会自动作为负样本使用。
- 人工确认前不得进入 train、val、test，也不得触发训练或部署。

## 运行

```bash
cd /home/admin1/jgzj

DATASET=.runtime/yolo_loop/datasets/weak_event_web_candidates_v1

HTTPS_PROXY=http://127.0.0.1:7897 \
HTTP_PROXY=http://127.0.0.1:7897 \
python3 scripts/crawl_fire_smoke_candidates.py \
  --output "$DATASET" \
  --commons-config config/wikimedia_weak_event_queries_v1.json \
  --dataset-schema jgzj_weak_event_web_candidate.v1 \
  --summary-schema jgzj_weak_event_web_candidate_summary.v1 \
  --profile 弱事件网络候选集 \
  --class-name fishing_rod \
  --class-name pet \
  --class-name stall \
  --class-name bottle \
  --class-name box \
  --class-name paper \
  --class-name bag \
  --training-guard-reason "Weak-event web candidates require two-pass Qwen review and human approval." \
  --max-images 300 \
  --user-agent "JGZJ-WeakEvent-Collector/1.0 (dataset research)"

NO_PROXY=127.0.0.1,localhost \
python3 scripts/label_weak_event_candidates_qwen.py \
  --dataset "$DATASET" \
  --endpoint http://127.0.0.1:18016 \
  --model Qwen3.6-27B-Labeler
```

标注服务允许并发时，可将同一清单拆成固定分片。并行分片必须使用 `--skip-summary`，全部结束后再由单进程生成一次总清单：

```bash
for index in 0 1 2 3; do
  NO_PROXY=127.0.0.1,localhost \
  python3 scripts/label_weak_event_candidates_qwen.py \
    --dataset "$DATASET" \
    --endpoint http://127.0.0.1:18016 \
    --model Qwen3.6-27B-Labeler \
    --shard-count 4 \
    --shard-index "$index" \
    --skip-summary &
done
wait

python3 scripts/label_weak_event_candidates_qwen.py \
  --dataset "$DATASET" \
  --max-images 0
```

重复执行会按 URL、SHA-256、感知哈希和标题系列去重，并复用已有 Qwen 缓存。

## 输出

- `manifest_selected_images.jsonl`：授权、来源、哈希和候选桶信息。
- `qwen_labels/`：逐图两遍 Qwen 原始结果和过滤结果。
- `qwen_review_manifest.jsonl`：来源清单与复核结果合并记录。
- `labels/review/`：仅供人工复核的 YOLO 文本框。
- `dataset_summary.json`：场景、目标和类别框统计。
- `training_guard.json`：训练隔离状态。

验收时至少检查清单数量一致、授权字段完整、难负样本桶没有直接保留正框，并确认全部记录仍为 `training_eligible=false`。
