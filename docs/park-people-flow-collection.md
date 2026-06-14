# 园区人流采集业务说明

更新时间：2026-06-14，Asia/Shanghai

## 目标

巡逻车只在确认执行巡逻任务时，低频调用 4 路相机采集园区图片，并绑定车辆定位、高德坐标、巡逻状态和后续人群识别结果。热力图必须建立在“采集点人数已识别”的数据上，不能只按图片数量直接画热力。

## 当前采集状态

- 自动监控已启用，每 5 分钟巡查一次正在巡逻的车辆。
- 每轮最多扫描 16 台车，最多真正抓拍 1 台，最多尝试 2 台。
- 抓拍策略：4 路相机 `camera1-camera4`，默认 `max_width=480`、`quality=40`。
- 采集门槛：同一车同一方向按位置距离 80m 和冷却 10 分钟门控。
- 截至本次检查：已有 106 条采集样本，约 424 张图片，图片和 sidecar 元数据文件约 848 个。
- 最近一次监控：2026-06-14 12:06 扫 16 台，符合采集门槛 0 台，本轮未抓拍。

## 巡逻判定

采集前必须通过车端只读工具判断巡逻状态，不能只看车速。

使用接口：

- `status.planning`：规划运行、loop/refline 进度、任务状态、长停、充电区。
- `status.can`：速度、运行模式、电池充电状态、故障灯、安全停。
- `status.routing`：仅在 planning/can 证据不足时补充路线任务证据。
- `status.localization`：只用于绑定坐标，不单独证明巡逻。

允许采集状态：

- `patrol_active_moving`
- `patrol_active_stopped`
- `patrol_task_stopped_or_waiting`

排除状态：

- 充电或充电区、安全停、心跳过期、非巡逻、任务完成/长停、状态未知、定位不可用。

## 数据落盘

运行目录：`.runtime/park-pcm`

- 图片：`crowd-frames/YYYYMMDD/*.jpg`
- 单张图片元数据：`crowd-frames/YYYYMMDD/*.json`
- 样本索引：`crowd-samples.jsonl`
- 抓拍状态：`crowd-capture-state.json`
- 自动监控状态：`crowd-monitor-state.json`
- 人数分析状态：`crowd-analysis-state.json`

原始样本和图片不重写。人数识别结果单独写入 `crowd-analysis-state.json`，接口返回时再合并，避免破坏原始采集证据链。

## 人数识别链路

已检查现有计算资源：

- 本机 8 张 RTX 4090，已有本地模型/语音服务占用显存，查询时 GPU 利用率为 0%。
- A100 文本通道：`127.0.0.1:18000`，模型 `Qwen3.6-27B` 可用。
- A100 多模态通道：`127.0.0.1:18001`，模型 `Qwen3.6-27B-MM` 可用。
- 本机多模态粗筛：`127.0.0.1:8012`，模型 `qwen3-vl-2b-checker` 可用。

当前默认策略：

- 自动人数分析先用本机 `qwen3-vl-2b-checker`，避免压 A100 主链路。
- 每 30 秒检查一次 GPU 空闲状态，最大 GPU 利用率不超过 15% 时才分析。
- 每轮最多分析 1 个采集点，4 路图串行调用。
- 每路输出 `people_count / confidence / note`。
- 采集点 aggregate 输出：
  - `people_count`：四路相机可见人数合计。
  - `max_single_camera_people`：单路最大人数，作为视角重叠时的保守参考。

已验证样例：

- `BIT-0033 / 114128_BIT-0033_370674ff65`：4 路合计 0 人。
- `BIT-0020 / 111548_BIT-0020_0941d0b6e6`：4 路合计 19 人，单路最大 7 人。
- `BIT-0014 / 110938_BIT-0014_5009e99bcf`：4 路合计 0 人。

最近检查时识别进度：15 个采集点已完成识别，四路合计 106 人；剩余待识别点会在 GPU 空闲时继续自动处理，具体数值以 `crowd-analysis-state.json` 和页面接口为准。

## 前端展示

入口：`/app/park-crowd`

当前页面能力：

- 顶部切车按 `vehicle_id` 查询服务器已经落盘的历史采集点和 4 路图片，不再拉车端实时定位。
- 地图显示历史采集轨迹和采集点，不画热力层；高德地图已启用拖拽、滚轮缩放、双击缩放和缩放控件。
- 采集点列表与地图联动。
- 选中采集点显示 4 路图片、坐标、采集时间、总人数和每路人数。
- 人数尚未分析时显示“人数待识别”。

## 接口

- `GET /api/park-pcm/crowd/vehicles`：车辆列表、默认采集参数。
- `GET /api/park-pcm/crowd/vehicles/:vehicle_id/detail`：单车实时定位、巡逻状态、采样统计，作为兼容接口保留，当前页面切车不再调用。
- `GET /api/park-pcm/crowd/patrols`：当前确认巡逻车辆。
- `GET /api/park-pcm/crowd/samples`：采集样本，支持 `vehicle_id` 过滤，自动合并人数分析结果。
- `POST /api/park-pcm/crowd/demo-capture`：手动 4 路抓拍，仍强制巡逻状态门控。
- `POST /api/park-pcm/crowd/analyze/run`：手动触发 1 轮人数分析。
- `GET /api/park-pcm/status`：监控、报告、人数分析状态。

## 后续热力图条件

热力图暂缓。满足以下条件后再做：

1. 采集点必须有 `gaode_longitude / gaode_latitude`。
2. 采集点必须有 `analysis.people_count` 或经过人工/模型复核的人数。
3. 热力权重使用人数，不使用单纯图片数量。
4. 同一采集点保留 `people_count` 和 `max_single_camera_people` 两个口径，避免四路视角重叠导致误判。
5. 对高人流点建议用 A100 `Qwen3.6-27B-MM` 做抽检复核，再进入广告引流分析。
