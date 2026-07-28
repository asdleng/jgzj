# YOLO 事件原图反馈候选集上下游链路

更新日期：2026-07-28

本文说明当前 `YOLO事件原图反馈候选集` 的完整上下游链路、关键目录、定时任务、页面入口和运维检查方式。仓库路径以 `/home/admin1/jgzj` 为基准；Qwen WebSocket 校核服务路径以 `/home/admin1/qwen-vl-infer` 为基准。

## 1. 总览

当前链路分五层：

1. 车端把事件原图、ROI、事件任务和候选框发给 Qwen WebSocket 校核服务。
2. `qwen_ws_checker_service.py` 判定结果并归档：
   - Qwen 判定为 YES 且不是排除事件的帧进入 `permanent_yes_frames`。
   - Qwen 判定为 NO 的帧先进入 `temporary_no_frames`；如果全图自动标注发现目标框，则提升到 `permanent_yes_frames`，source 记为 `qwen_no_labeler_positive_frame`。
3. `jgzj` 里的 Qwen 自动标注和二次校核定时任务，对永久归档帧补全全图框和审核结果。
4. `run_yolo_event_feedback_sync.sh` 每小时两次构建 `yolo_event_feedback_v1` 候选集。
5. 每天凌晨 00:31 到 00:36，6 个 finetune 追加任务从候选集中选前一天有目标框的数据，拷贝图片和标签到对应 `finetune_*` 数据集。

候选集本身是审核候选，不直接用于训练，`training_guard.json` 固定为不可训练。下游 `finetune_*` 数据集是二次整合后的训练候选数据集，会出现在 `/app/yolo-label-review` 的“二次整合数据集”来源下面。

## 2. 在线归档入口

服务位置：

```text
/home/admin1/qwen-vl-infer/qwen_ws_checker_service.py
/home/admin1/qwen-vl-infer/start_qwen_ws_checker_stack.sh
```

当前服务端口和入口：

```text
local health: http://127.0.0.1:8794/healthz
local ws:     ws://127.0.0.1:8794/ws/qwen/check
frp ws:       ws://idtrd.kmdns.net:7789/ws/qwen/check
```

关键归档目录：

```text
/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive
/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive/qwen_ws_checker.sqlite3
/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive/permanent_yes_frames
/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive/temporary_no_frames
```

当前启动脚本的关键默认值：

```text
ARCHIVE_RETENTION_DAYS=7
TEMPORARY_NO_RETENTION_DAYS=3
ARCHIVE_CLEANUP_INTERVAL_SEC=3600
NO_LABELER_ENABLED=1
NO_LABELER_CHAT_URL=http://127.0.0.1:18016/v1/chat/completions
NO_LABEL_OUTPUT_ROOT=/home/admin1/jgzj/.runtime/yolo_label_review/qwen_permanent_yes_bbox_labels_v1
```

永久归档帧的 JSON 元信息主要有两种 source：

```text
qwen_permanent_yes_frame
qwen_no_labeler_positive_frame
```

其中 `qwen_permanent_yes_frame` 来自 Qwen 对车端事件任务判定 YES；`qwen_no_labeler_positive_frame` 来自 Qwen 判 NO 后的全图自动标注补捞，只在自动标注存在目标框时进入永久归档。

YES 永久归档会排除以下基础目标事件，避免 person/car/nonmotor 等常规检测事件把事件反馈候选集撑爆：

```text
person
car
non_motorvehicle
non_motor_vehicle
nonmotor_vehicle
nonmotorvehicle
motorcycle
```

8794 的 `/healthz` watchdog 已安装在：

```text
/home/admin1/qwen-vl-infer/watch_qwen_ws_checker_healthz.sh
```

watchdog 每分钟检查一次 `/healthz`，连续 2 次失败后终止 8794 进程并调用 `start_qwen_ws_checker_stack.sh` 重启。

状态与日志：

```text
/home/admin1/logs/qwen3_vl_2b_ws_checker/watchdog_8794.state
/home/admin1/logs/qwen3_vl_2b_ws_checker/watchdog_8794.log
/home/admin1/logs/qwen3_vl_2b_ws_checker/ws_8794.log
/home/admin1/logs/qwen3_vl_2b_ws_checker/vllm_8012.log
```

## 3. 自动标注和二次校核

事件原图反馈候选集依赖永久归档帧的全图自动框和审核结果：

```text
.runtime/yolo_label_review/qwen_permanent_yes_bbox_labels_v1
.runtime/yolo_label_review/qwen_permanent_yes_bbox_audits_v1
```

对应脚本：

```text
scripts/run_qwen_permanent_yes_label_incremental.sh
scripts/patrol_qwen_label_permanent_yes_frames.py
scripts/run_qwen_permanent_yes_bbox_audit_incremental.sh
scripts/patrol_qwen_audit_permanent_yes_frames.py
```

处理策略：

1. 自动标注任务调用 `http://127.0.0.1:18016/health` 和对应 chat/completions 服务，对永久归档帧补全独立全图 YOLO 框。
2. 审核任务读取自动标注结果，输出 `verdict`、可疑框、遗漏候选等二次校核信息。
3. 候选集同步时按图片 SHA 读取 label/audit 缓存；有审核结果时会把 `suspect`、`needs_human`、`error` 计入人工复核队列。

车端上传数据的标注/审核任务也在同一页面使用，但它们主要服务 `/app/yolo-label-review` 的“车辆自采”来源，不是 `yolo_event_feedback_v1` 的主输入：

```text
.runtime/yolo_label_review/vehicle_upload_qwen_bbox_labels_v1
.runtime/yolo_label_review/vehicle_upload_qwen_bbox_audits_v1
```

对应脚本：

```text
scripts/run_vehicle_upload_qwen_label_incremental.sh
scripts/patrol_qwen_label_vehicle_uploads.py
scripts/run_vehicle_upload_qwen_bbox_audit_incremental.sh
scripts/patrol_qwen_bbox_audit.py
```

## 4. 候选集构建

主同步脚本：

```text
scripts/run_yolo_event_feedback_sync.sh
scripts/build_yolo_event_feedback_dataset.py
```

默认输入：

```text
PERMANENT_ROOT=/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive/permanent_yes_frames
LABEL_ROOT=/home/admin1/jgzj/.runtime/yolo_label_review/qwen_permanent_yes_bbox_labels_v1
AUDIT_ROOT=/home/admin1/jgzj/.runtime/yolo_label_review/qwen_permanent_yes_bbox_audits_v1
```

默认输出：

```text
.runtime/yolo_loop/datasets/yolo_event_feedback_v1
.runtime/yolo_loop/datasets/yolo_event_feedback_v1/images/review
.runtime/yolo_loop/datasets/yolo_event_feedback_v1/labels/review
.runtime/yolo_loop/datasets/yolo_event_feedback_v1/manifest_selected_images.jsonl
.runtime/yolo_loop/datasets/yolo_event_feedback_v1/dataset_summary.json
.runtime/yolo_loop/datasets/yolo_event_feedback_v1/training_guard.json
```

同步默认保留最近 30 个上海自然日：

```text
YOLO_EVENT_FEEDBACK_DAYS=30
YOLO_EVENT_FEEDBACK_DEDUPE_EXACT=1
YOLO_EVENT_FEEDBACK_DEDUPE_NEAR=0
```

图片物化策略：

1. 优先用硬链接把永久归档帧放进候选集。
2. 跨文件系统无法硬链接时回退为 `copy2`。
3. 每次同步会删除当前窗口之外的生成文件，保持候选集与 manifest 一致。

候选集支持的目标类：

```text
person
vehicle
nonmotor
fire
smoke
trash
pet
stall
phone
smoking
license_plate
lying
fighting
falldown
```

候选状态：

```text
agreement        边缘事件期望类别在 Qwen 独立标注中存在
needs_human      边缘事件与 Qwen 独立标注/审核意见不一致，需要人工复核
pending_label    独立标注未完成或标注结果无效
quality_blocked  图片质量不可用于自动判断
review_only      暂无可训练目标类别或 NO 后补捞正样本，只用于查看/复核
```

`manifest_selected_images.jsonl` 的核心字段：

```text
image
split
is_positive
box_count
device_ids
camera_ids
days
source_frame
source_meta
source
image_sha256
feedback_status
feedback_reason
expected_classes
missing_expected_classes
independent_classes
independent_label_path
audit_path
audit_verdict
training_eligible
tasks
```

训练保护：

```text
.runtime/yolo_loop/datasets/yolo_event_feedback_v1/training_guard.json
training_eligible=false
reason=Event predictions are untrusted candidates until manual review resolves edge/cloud disagreements.
```

## 5. 下游 finetune 追加

每日追加入口：

```text
scripts/run_yolo_event_feedback_finetune_daily.sh
scripts/append_finetune_from_yolo_event_feedback_daily.py
```

默认行为：

```text
FINETUNE_DAY 默认为前一个上海自然日
SOURCE=.runtime/yolo_loop/datasets/yolo_event_feedback_v1
DATASETS_ROOT=.runtime/yolo_loop/datasets
```

6 个 profile 和目标类别：

```text
finetune_lying          lying
finetune_license_plate  license_plate
finetune_trash          bottle, box, paper, bag
finetune_smoking        smoking
finetune_pet            pet
finetune_v2             fire, smoke
```

输出目录：

```text
.runtime/yolo_loop/datasets/finetune_lying
.runtime/yolo_loop/datasets/finetune_license_plate
.runtime/yolo_loop/datasets/finetune_trash
.runtime/yolo_loop/datasets/finetune_smoking
.runtime/yolo_loop/datasets/finetune_pet
.runtime/yolo_loop/datasets/finetune_v2
```

每个 finetune 数据集会维护：

```text
images/train
images/val
images/test
labels/train
labels/val
labels/test
train.txt
val.txt
test.txt
classes.txt
data.yaml
manifest_selected_images.jsonl
dataset_summary.json
```

追加筛选逻辑：

1. 只读取目标日期在 `manifest_selected_images.jsonl` 里的候选行。
2. 按图片 SHA 去重；已进入目标 finetune 数据集的图不会重复追加。
3. 只追加能取到目标类别框的图片。
4. 框来源优先级：
   - 二次校核结果里的可用框，跳过审核判为错误或可疑删除的框。
   - Qwen 自动标注框。
   - 候选集里的 YOLO label txt。
   - 车端上传任务里的 `merged_box` 或 `crop_box`。
5. train/val/test 由图片 SHA 确定，比例约为 80/10/10。
6. 每次运行写入报告：

```text
.runtime/yolo_event_feedback_finetune_daily/reports/{profile}_{YYYYMMDD}.json
.runtime/yolo_event_feedback_finetune_daily/logs/{profile}.log
```

当前实现不直接读取 `/app/yolo-label-review` 的人工标注覆盖来追加训练样本；人工复核主要用于页面复核队列状态、人工修正和后续人工导出决策。每日自动追加只依赖候选集 manifest、Qwen 自动标注/审核缓存、候选集 label txt 和车端任务框。

## 6. 页面入口和后端接口

页面入口：

```text
http://idtrd.kmdns.net:7791/app/yolo-label-review
```

前端代码：

```text
src/pages/app/yolo-label-review.astro
src/components/EmbeddedYoloLabelReview.astro
public/js/yolo-label-review.js
```

后端代码：

```text
backend/server.js
backend/yolo-manual-review.js
```

主要接口：

```text
GET  /api/yolo-label-review/datasets
GET  /api/yolo-label-review/daily-stats
GET  /api/yolo-label-review/items
GET  /api/yolo-label-review/item
POST /api/yolo-label-review/annotation
POST /api/yolo-label-review/item/delete
GET  /api/yolo-label-review/file
POST /api/internal/yolo-label-review/rebuild-patrol-index
```

访问权限：

```text
ai:yolo:review
```

页面数据集来源分组：

```text
vehicle_collection   车辆自采
web_crawler          网络搜索数据集
finetune_dataset     二次整合数据集
checker_archive      云端校核
public_dataset       公开数据集
```

`yolo_event_feedback_v1` 通常归在“云端校核”；6 个 `finetune_*` 输出数据集归在“二次整合数据集”。

人工标注和删除状态保存到：

```text
.runtime/yolo_label_review/manual_annotations_v1
.runtime/yolo_label_review/manual_annotations_v1/deleted_items.jsonl
```

## 7. 当前相关定时任务

以下为 `admin1` 当前 crontab 中与本链路相关的任务。

### 7.1 8794 healthz watchdog

```cron
* * * * * /home/admin1/qwen-vl-infer/watch_qwen_ws_checker_healthz.sh >/dev/null 2>&1
```

作用：

```text
每分钟检查 http://127.0.0.1:8794/healthz；
连续失败 2 次后重启 qwen_ws_checker_service.py --port 8794。
```

### 7.2 车端上传图 Qwen 自动标注

```cron
*/30 * * * * cd /home/admin1/jgzj && /usr/bin/env bash scripts/run_vehicle_upload_qwen_label_incremental.sh
```

作用：

```text
每 30 分钟处理车辆自采/上传图片缺失的 Qwen bbox 自动标注；
输出到 .runtime/yolo_label_review/vehicle_upload_qwen_bbox_labels_v1；
完成后刷新 yolo-label-review 巡逻索引。
```

### 7.3 车端上传图 Qwen 二次审核

```cron
*/5 * * * * cd /home/admin1/jgzj && VEHICLE_QWEN_AUDIT_MAX_NEW=1000 VEHICLE_QWEN_AUDIT_WORKERS=4 /usr/bin/env bash scripts/run_vehicle_upload_qwen_bbox_audit_incremental.sh
```

作用：

```text
每 5 分钟审核车辆自采/上传图的 Qwen bbox；
输出到 .runtime/yolo_label_review/vehicle_upload_qwen_bbox_audits_v1；
默认包含空框样本，审核类别覆盖 person、vehicle、nonmotor、fire、smoke、pet、trash、stall、phone、smoking、license_plate、lying、fighting、falldown；
有新增审核行时刷新 yolo-label-review 巡逻索引。
```

### 7.4 永久 YES 帧 Qwen 自动标注

```cron
5 * * * * cd /home/admin1/jgzj && QWEN_PERMANENT_YES_LABEL_MAX_NEW=30 QWEN_PERMANENT_YES_LABEL_WORKERS=1 /usr/bin/env bash scripts/run_qwen_permanent_yes_label_incremental.sh
```

作用：

```text
每小时第 5 分钟处理 permanent_yes_frames 缺失的 Qwen 全图 bbox 自动标注；
这是 yolo_event_feedback_v1 的主标注输入；
输出到 .runtime/yolo_label_review/qwen_permanent_yes_bbox_labels_v1。
```

### 7.5 永久 YES 帧 Qwen 二次审核

```cron
35 * * * * cd /home/admin1/jgzj && QWEN_PERMANENT_YES_AUDIT_MAX_NEW=30 QWEN_PERMANENT_YES_AUDIT_WORKERS=1 QWEN_PERMANENT_YES_AUDIT_CLASS_FILTER= /usr/bin/env bash scripts/run_qwen_permanent_yes_bbox_audit_incremental.sh
```

作用：

```text
每小时第 35 分钟审核 permanent_yes_frames 的 Qwen bbox；
QWEN_PERMANENT_YES_AUDIT_CLASS_FILTER= 表示不限制审核类别；
输出到 .runtime/yolo_label_review/qwen_permanent_yes_bbox_audits_v1。
```

### 7.6 历史拉取图 Qwen 自动标注

```cron
18 * * * * cd /home/admin1/jgzj && QWEN_PERMANENT_YES_ROOT=/home/admin1/pulled_images_before_20260708_excluding_person_car_non_motorVehicle_conf_gt_0_8 QWEN_PERMANENT_YES_SOURCE=pulled_remote_dateconf_filter QWEN_PERMANENT_YES_INCLUDE_BARE_IMAGES=1 QWEN_PERMANENT_YES_SHA_INDEX=/home/admin1/jgzj/.runtime/yolo_label_review/pulled_images_before_20260708.sha_index.json QWEN_PERMANENT_YES_LABEL_MAX_NEW=120 QWEN_PERMANENT_YES_LABEL_WORKERS=2 /usr/bin/env bash scripts/run_qwen_permanent_yes_label_incremental.sh
```

作用：

```text
每小时第 18 分钟处理历史拉取图；
复用 permanent yes 标注脚本，但输入根目录和 source 改为 pulled_remote_dateconf_filter；
主要补历史样本标注，不是实时 event feedback 主入口。
```

### 7.7 历史拉取图 Qwen 二次审核

```cron
48 * * * * cd /home/admin1/jgzj && QWEN_PERMANENT_YES_ROOT=/home/admin1/pulled_images_before_20260708_excluding_person_car_non_motorVehicle_conf_gt_0_8 QWEN_PERMANENT_YES_SOURCE=pulled_remote_dateconf_filter QWEN_PERMANENT_YES_INCLUDE_BARE_IMAGES=1 QWEN_PERMANENT_YES_SHA_INDEX=/home/admin1/jgzj/.runtime/yolo_label_review/pulled_images_before_20260708.sha_index.json QWEN_PERMANENT_YES_AUDIT_MAX_NEW=120 QWEN_PERMANENT_YES_AUDIT_WORKERS=1 QWEN_PERMANENT_YES_AUDIT_CLASS_FILTER= QWEN_PERMANENT_YES_AUDIT_EXTRA_ARGS=--include-empty /usr/bin/env bash scripts/run_qwen_permanent_yes_bbox_audit_incremental.sh
```

作用：

```text
每小时第 48 分钟审核历史拉取图；
--include-empty 会把空框样本也纳入审核输出。
```

### 7.8 YOLO 事件原图反馈候选集同步

```cron
20,50 * * * * cd /home/admin1/jgzj && /usr/bin/env bash scripts/run_yolo_event_feedback_sync.sh
```

作用：

```text
每小时第 20 和 50 分钟构建 .runtime/yolo_loop/datasets/yolo_event_feedback_v1；
默认扫描最近 30 个上海自然日；
读取 permanent_yes_frames、qwen_permanent_yes_bbox_labels_v1、qwen_permanent_yes_bbox_audits_v1；
输出 manifest、dataset_summary、training_guard 和 review 图片/标签。
```

### 7.9 每日 finetune 追加

```cron
# JGZJ daily YOLO event feedback finetune copy append; previous Shanghai day, after feedback sync.
31 0 * * * cd /home/admin1/jgzj && FINETUNE_PROFILE=finetune_lying /usr/bin/env bash scripts/run_yolo_event_feedback_finetune_daily.sh
32 0 * * * cd /home/admin1/jgzj && FINETUNE_PROFILE=finetune_license_plate /usr/bin/env bash scripts/run_yolo_event_feedback_finetune_daily.sh
33 0 * * * cd /home/admin1/jgzj && FINETUNE_PROFILE=finetune_trash /usr/bin/env bash scripts/run_yolo_event_feedback_finetune_daily.sh
34 0 * * * cd /home/admin1/jgzj && FINETUNE_PROFILE=finetune_smoking /usr/bin/env bash scripts/run_yolo_event_feedback_finetune_daily.sh
35 0 * * * cd /home/admin1/jgzj && FINETUNE_PROFILE=finetune_pet /usr/bin/env bash scripts/run_yolo_event_feedback_finetune_daily.sh
36 0 * * * cd /home/admin1/jgzj && FINETUNE_PROFILE=finetune_v2 /usr/bin/env bash scripts/run_yolo_event_feedback_finetune_daily.sh
```

作用：

```text
每天凌晨按 profile 追加前一个上海自然日的数据；
只追加有目标类别框且未重复进入目标数据集的图片；
拷贝图片和 YOLO label 到对应 finetune_* 数据集；
写入 daily ingest 报告和 dataset_summary。
```

## 8. 推荐检查命令

检查 8794：

```bash
curl -fsS --max-time 5 http://127.0.0.1:8794/healthz
pgrep -af "qwen_ws_checker_service.py.*--port 8794"
cat /home/admin1/logs/qwen3_vl_2b_ws_checker/watchdog_8794.state
tail -100 /home/admin1/logs/qwen3_vl_2b_ws_checker/watchdog_8794.log
tail -100 /home/admin1/logs/qwen3_vl_2b_ws_checker/ws_8794.log
```

检查永久归档是否有当天新增：

```bash
find /home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive/permanent_yes_frames/$(date +%Y%m%d) -type f -name "*.json" | wc -l
```

检查候选集同步：

```bash
cd /home/admin1/jgzj
tail -100 .runtime/yolo_event_feedback/sync.log
jq '.feedback.day_counts, .feedback.status_counts, .feedback.dedupe' .runtime/yolo_loop/datasets/yolo_event_feedback_v1/dataset_summary.json
```

手动同步候选集：

```bash
cd /home/admin1/jgzj
/usr/bin/env bash scripts/run_yolo_event_feedback_sync.sh
```

强制同步并刷新页面巡逻索引：

```bash
cd /home/admin1/jgzj
YOLO_EVENT_FEEDBACK_REFRESH_PATROL_INDEX=1 /usr/bin/env bash scripts/run_yolo_event_feedback_sync.sh
```

手动跑某个 finetune 追加：

```bash
cd /home/admin1/jgzj
FINETUNE_PROFILE=finetune_pet /usr/bin/env bash scripts/run_yolo_event_feedback_finetune_daily.sh
```

手动指定日期 dry-run：

```bash
cd /home/admin1/jgzj
FINETUNE_PROFILE=finetune_pet FINETUNE_DAY=20260728 FINETUNE_DRY_RUN=1 /usr/bin/env bash scripts/run_yolo_event_feedback_finetune_daily.sh
```

查看每日追加报告：

```bash
cd /home/admin1/jgzj
ls -ltr .runtime/yolo_event_feedback_finetune_daily/reports
jq '.added_images, .added_boxes, .label_source_counts, .scan' .runtime/yolo_event_feedback_finetune_daily/reports/finetune_pet_20260728.json
```

## 9. 故障判断

如果 `yolo_event_feedback_v1` 某天没有新增，按顺序检查：

1. `curl http://127.0.0.1:8794/healthz` 是否返回 `ok`。
2. `permanent_yes_frames/YYYYMMDD` 是否有 JSON 元信息。
3. `.runtime/yolo_label_review/qwen_permanent_yes_bbox_labels_v1` 是否有对应 SHA 的标注缓存。
4. `.runtime/yolo_label_review/qwen_permanent_yes_bbox_audits_v1` 是否有审核缓存。
5. `.runtime/yolo_event_feedback/sync.log` 是否有 `lock_busy`、异常或 total_images 不增长。
6. `dataset_summary.json` 的 `feedback.day_counts` 是否包含目标日期。
7. finetune 追加报告里 `scan.day_rows` 和 `added_images` 是否为 0；如果 `day_rows=0`，说明候选集当天没有数据；如果 `day_rows>0` 但 `added_images=0`，通常是无目标类别框或已去重。

如果 `/app/yolo-label-review` 页面看不到新数据：

1. 等待数据集列表缓存自动过期，默认 5 分钟。
2. 对车辆自采巡逻索引可调用 `/api/internal/yolo-label-review/rebuild-patrol-index`。
3. 检查 `backend/server.js` 是否正常运行，以及当前用户是否有 `ai:yolo:review` 权限。

## 10. 当前设计边界

1. `yolo_event_feedback_v1` 是候选审核集，默认不可直接训练。
2. 6 个 `finetune_*` 追加任务是训练候选数据集入口，会拷贝图片和标签，不使用硬链接。
3. 每日自动追加读取的是前一天数据；如果 8794 曾中断导致某天无归档，需要先恢复 8794，再等新数据进入永久归档并跑同步。
4. NO 后补捞正样本只有在全图自动标注有框时才提升进入永久归档；无框 NO 样本会按临时目录保留策略清理。
5. crontab 是系统状态，不在 git 仓库内；脚本和本文档在 git 仓库内。
