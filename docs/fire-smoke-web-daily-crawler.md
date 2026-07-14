# 烟火图片每日爬虫与 Qwen 标注说明

## 1. 任务目标

这项任务每天从 Wikimedia Commons 采集有许可证信息的烟雾、火焰和高风险负样本，去重后写入 JGZJ 的烟火网络候选集，再由 `Qwen3.6-27B-Labeler` 做检测和第二遍视觉复核。

它只维护人工审核候选集，不会自动加入 YOLO 的 train/val/test，也不会触发模型训练。以下文件及每条数据都必须保持 `training_eligible=false`：

- `training_guard.json`
- `dataset_summary.json`
- `manifest_selected_images.jsonl`
- `qwen_review_manifest.jsonl`

## 2. 调度和数量

- 调度方式：systemd timer，不依赖终端保持开启。
- 执行时间：每天 `02:20`，时区 `Asia/Shanghai`。
- 每日目标：最多新增 50 张。
- 失败重试：15 分钟后重试，6 小时内最多启动 3 次。
- 补跑规则：同一天第一次运行会固定当天的基线和目标；即使中途失败，重试仍使用同一个目标，不会再额外增加 50 张。
- 断电补跑：timer 使用 `Persistent=true`，错过当天执行时间后会在系统恢复时补跑。

每日配置会交错采集火灾、烟雾和 hard negative，包括建筑/车辆/住宅火灾、火灾烟雾，以及雾、尾气、烟囱、消防栓、灭火器、消防柜、扬尘、夜间灯光和晚霞。每个标题/事件系列最多保留 4 张，避免同一场事故连续照片占满数据集。

## 3. 关键路径

服务器项目：

```text
/home/admin1/jgzj
```

滚动候选集：

```text
/home/admin1/jgzj/.runtime/yolo_loop/datasets/fire_smoke_web_candidates_v3
```

每日任务状态：

```text
/home/admin1/jgzj/.runtime/yolo_loop/fire_smoke_web_daily/state.json
```

主要程序和配置：

```text
scripts/run_fire_smoke_web_daily.py
scripts/crawl_fire_smoke_candidates.py
scripts/label_fire_smoke_candidates_qwen.py
config/wikimedia_fire_smoke_queries_daily.json
```

网页入口：

```text
JGZJ -> YOLO标签 -> 烟火 -> 网络爬虫 -> fire_smoke_web_candidates_v3
```

网页默认隐藏无框项，关闭“隐藏无框”后可以查看正样本、hard negative、需人工确认和不可用图片的全集。

## 4. 网络和 Qwen

服务器的终端默认没有代理环境变量。systemd service 已固定使用：

```text
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
ALL_PROXY=http://127.0.0.1:7897
NO_PROXY=127.0.0.1,localhost
```

Commons API 和图片下载走代理；本机 Qwen 入口必须绕过代理：

```text
http://127.0.0.1:18016
model=Qwen3.6-27B-Labeler
```

编排器会在爬图前检查 `/v1/models`。如果 Qwen 不可用，当次运行直接失败并等待 systemd 重试，不先产生未标注图片。

## 5. 数据安全闸门

采集阶段执行以下检查：

- 只接受 Public Domain、CC0、CC BY、CC BY-SA 等允许的许可证元数据。
- 校验 MIME、图片可解码性、最小尺寸、最大文件大小和单图下载超时。
- 对 v2 和当前 v3 做来源 URL、SHA256、dHash 近重复去重。
- 每个标准化标题/事件系列最多 4 张。
- 搜索词只作为候选提示，不当作图片真值。

标注阶段执行两遍 Qwen 视觉判断，并过滤雾、蒸汽、云、扬尘、晚霞、灯光、反光和消防设备等常见误报。`hard_negative_*` 来源即使被模型判为正样本，也会强制转入 `needs_human`。

每日任务结束前必须同时通过：

- 原始 manifest 和 Qwen review manifest 数量一致、SHA256 一一对应且无重复。
- hard-negative 的最终 scene 中没有 `positive`。
- 数据集汇总、训练闸门、原始 manifest 和 review manifest 的训练资格均为 `false`。

任一检查失败，service 状态为 failed，不会把这批候选数据放入训练。

## 6. 常用命令

查看下一次执行时间：

```bash
systemctl list-timers jgzj-fire-smoke-web-daily.timer --all
systemctl status jgzj-fire-smoke-web-daily.timer --no-pager
```

查看最近运行结果和日志：

```bash
cat /home/admin1/jgzj/.runtime/yolo_loop/fire_smoke_web_daily/state.json
journalctl -u jgzj-fire-smoke-web-daily.service -n 200 --no-pager
```

只看计划，不下载、不调用 Qwen、不改 state：

```bash
cd /home/admin1/jgzj
/usr/bin/python3 scripts/run_fire_smoke_web_daily.py --dry-run
```

手工立即执行一次正式任务：

```bash
sudo systemctl start jgzj-fire-smoke-web-daily.service
systemctl status jgzj-fire-smoke-web-daily.service --no-pager
```

同一天重复执行是幂等的：如果当天已达到固定目标，爬虫不会再加图片，只会补齐失败或缺失的 Qwen 结果并重新检查安全闸门。

暂停和恢复定时任务：

```bash
sudo systemctl disable --now jgzj-fire-smoke-web-daily.timer
sudo systemctl enable --now jgzj-fire-smoke-web-daily.timer
```

修改 service 或 timer 后：

```bash
sudo systemctl daemon-reload
sudo systemctl restart jgzj-fire-smoke-web-daily.timer
```

## 7. 故障处理

### Commons 超时

先检查本机代理端口，再确认 service 环境变量：

```bash
ss -lntp | grep 7897
systemctl show jgzj-fire-smoke-web-daily.service -p Environment
```

不要改成直接下载 `upload.wikimedia.org`；当前出口容易收到 429，采集器使用 `commons.wikimedia.org/w/thumb.php` 官方缩略图入口。

### Qwen 不可用

```bash
curl --noproxy '*' -fsS --max-time 10 http://127.0.0.1:18016/v1/models
```

恢复 Qwen 或隧道后，systemd 会按失败策略重试；也可以手工启动 service。同一天的 `target_count` 不会变化。

### 当天没有新增到 50 张

这通常表示当前查询窗口内的新图都已采集、许可证不符合、图片重复、属于同一标题系列，或下载失败。50 是上限，不是为了凑数而绕过质量门槛的硬指标。可从以下位置查看分类计数：

```text
fire_smoke_web_candidates_v3/dataset_summary.json
fire_smoke_web_candidates_v3/crawl_log.jsonl
```

不要通过关闭许可证、去重、hard-negative 隔离或训练闸门来强行补足数量；需要扩充时应先增加精确 Commons 类别并执行小批量验证。
