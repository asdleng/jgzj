# YOLO 事件原图反馈闭环

## 数据来源

车端事件进入 Qwen 复核时，云端会把完整无框图、ROI、事件名和 Qwen 结果保存到：

```text
/home/admin1/qwen-vl-infer/data/qwen_ws_checker_archive/permanent_yes_frames
```

独立全图预标注及审核缓存位于：

```text
.runtime/yolo_label_review/qwen_permanent_yes_bbox_labels_v1
.runtime/yolo_label_review/qwen_permanent_yes_bbox_audits_v1
```

## 候选集

`build_yolo_event_feedback_dataset.py` 按图像 SHA 合并边缘事件和云端独立标注，生成：

```text
.runtime/yolo_loop/datasets/yolo_event_feedback_v1
```

候选状态：

- `agreement`：边缘事件对应的目标类在云端独立标注中存在。
- `needs_human`：边缘事件与云端独立标注意见不一致，必须人工确认。
- `pending_label`：独立标注尚未完成或结果无效。
- `quality_blocked`：图片质量不可用于自动判断。
- `review_only`：事件暂时没有对应的 YOLO 训练类别，仅留作审核。

## 训练保护

该数据集只用于候选审核，`training_guard.json` 固定声明：

```json
{"training_eligible": false}
```

每日人员、车辆闭环仍只读取审核通过的 `auto_ad_patrol_flow_upload`。事件原图必须经过人工确认并导出为任务专项正样本或 hard negative，才允许进入后续训练数据集。

## 定时同步

服务器每小时两次运行：

```text
scripts/run_yolo_event_feedback_sync.sh
```

同步使用硬链接复用云端归档图，不重复占用图片数据空间；跨文件系统时才回退为复制。
YOLO 页面数据集列表最长缓存 5 分钟，正常同步不强制重建 4 万余条巡逻索引。首次部署或需要立即刷新时可执行：

```text
YOLO_EVENT_FEEDBACK_REFRESH_PATROL_INDEX=1 scripts/run_yolo_event_feedback_sync.sh
```
