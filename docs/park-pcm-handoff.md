# Park PCM 巡逻采集交接记录

更新时间：2026-06-12 20:58 左右，Asia/Shanghai

## 当前目标

做园区“人流”PCM demo，不是车辆流量。车辆在巡逻过程中定时/定距用 4 路相机抓拍，云端保存图片并绑定定位，后续接入识别模型/大模型做人数、男女、年龄段、高矮、人群热力、广告引流分析。

用户最新纠正：以后必须确认车辆正在执行巡逻任务才允许采集，不能只看车速。车速为 0 可能是充电区，也可能是巡逻途中遇到障碍物停住。需要研究车端接口判断“执行巡逻任务”。

## 已完成改动

- `backend/server.js` 里已经把私有导航中的“云端建图”入口隐藏；直接路由仍存在。
- `backend/park-pcm.js` 已加入人流 4 路相机 demo 采集基础能力：
  - 保存图片到 `.runtime/park-pcm/crowd-frames/YYYYMMDD`
  - 保存样本索引到 `.runtime/park-pcm/crowd-samples.jsonl`
  - 保存上次采集位置/时间到 `.runtime/park-pcm/crowd-capture-state.json`
  - 支持 WGS84 到 GCJ-02/高德坐标转换
  - 支持按距离和冷却时间做采集门控
  - 已加入采集前巡逻状态门控，`force` 只跳过距离/冷却，不跳过巡逻判断
  - 已把飞书小时报告切换为人流采样口径，不再发送旧车辆流量/告警报告
  - 新增接口：
    - `GET /api/park-pcm/crowd/vehicles`
    - `GET /api/park-pcm/crowd/samples`
    - `POST /api/park-pcm/crowd/demo-capture`
    - `GET /api/park-pcm/crowd/files/*`
- `src/components/EmbeddedParkPcmConsole.astro` 已改成只显示“4 路相机人流采样”工作台，旧快照、旧告警、旧全车 PCM 明细已移除。
- `src/scripts/park-pcm.js` 已收窄为登录校验、车辆加载、样本展示、手动 4 路抓拍逻辑。
- `.runtime/park-pcm` 下门控上线前产生、没有 `patrol_state` 的旧样本已清空。

## 已验证

- `PATH=/home/admin1/jgzj/.runtime/node-v20.20.1-linux-x64/bin:$PATH node --check backend/park-pcm.js` 通过。
- `PATH=/home/admin1/jgzj/.runtime/node-v20.20.1-linux-x64/bin:$PATH node --check src/scripts/park-pcm.js` 通过。
- `PATH=/home/admin1/jgzj/.runtime/node-v20.20.1-linux-x64/bin:$PATH npm run build` 通过。
- `sudo systemctl restart jgzj-site.service && sleep 2 && curl -fsS http://127.0.0.1:8888/healthz` 通过。
- 生产路由需要登录/权限，未登录访问 `/api/park-pcm/crowd/vehicles` 返回 `401 vehicle:read`。
- 用 mock app 直接调用 `POST /api/park-pcm/crowd/demo-capture` 测 BIT-0011，返回：
  - `skipped = true`
  - `reason = not_patrol`
  - `capture_eligible = false`
  - 本次 `planning/routing/can` 均超时，因此状态为 `unknown`，按保守策略不抓拍。
- 验证 `.runtime/park-pcm/crowd-frames` 文件数为 `0`，`crowd-samples.jsonl` 大小为 `0`。

## 4 路相机带宽小测

用 `camera.capture` 时不要传 `camera:"all"`；BIT-0041 返回过错误：

`unknown camera alias: all; available aliases: back, camera1, camera2, camera3, camera4, front, left, right`

正确参数应使用：

```json
{
  "camera_ids": ["camera1", "camera2", "camera3", "camera4"],
  "quality": 45,
  "max_width": 480,
  "include_base64": true
}
```

小测结果：

- 4 路图片 decoded 总大小约 `673671` 字节。
- HTTP 响应下载约 `899925` 字节。
- 请求耗时约 `32.37s`。
- 单张约 `109KB - 199KB`。

另一次 BIT-0011 demo：

- 4 路图片总大小 `540309` 字节。
- 请求耗时约 `3.7s`。
- 但这条不应算正式样本，因为 BIT-0011 后续确认不是巡逻状态；该样本已删除。

## BIT-0011 当前判断

最新只读查询结果显示 BIT-0011 不应判为巡逻中：

- `status.planning`
  - `planner_running = 0`
  - `planner_state = unknown`
  - `current_scenario = 1`
  - `current_action = 0`
  - `vehicle_idle_status = 1`
  - `current_loop_index = 0`
  - `total_loop_sum = 0`
  - `current_refline_index = 0`
  - `total_refline_sum = 0`
  - `trajectory_total_length = 0`
  - `long_time_stop = true`
  - `in_charger_zone = false`
- `status.routing`
  - `current_path_string_ids = []`
  - `current_route_location` 无有效坐标
- `status.can`
  - `speed = 0`
  - `running_mode = 2`
  - `battery_charge_state = 1`
  - `fault_lamps_on` 包含 `charge`
  - `vehicle_ready = true`
- `status.localization`
  - 定位可靠，但这只能用于坐标绑定，不能证明巡逻。

结论：BIT-0011 不能进入人流采样队列。之前生成的 BIT-0011 demo 样本已删除。

## 巡逻状态接口线索

优先依据 `cloud_control` 车端工具：

- `status.planning`
  - `planner_running`
  - `vehicle_idle_status`
  - `current_loop_index`
  - `total_loop_sum`
  - `current_refline_index`
  - `total_refline_sum`
  - `current_scenario`
  - `current_action`
  - `long_time_stop`
  - `in_charger_zone`
- `status.routing`
  - `current_path_string_ids`
  - `current_route_location`
  - route catalog/progress
- `status.can`
  - `speed`
  - `running_mode`
  - `battery_charge_state`
  - `fault_lamps_on`
  - `emergency_stop`
  - `collision_stop`
  - `ultrasonic_stop`
- `status.localization`
  - 只用于绑定位置和高德热力坐标，不单独作为巡逻依据。

## 建议巡逻判定规则

不能只看车速。

硬排除：

- 心跳过期或车辆不可确认在线。
- `in_charger_zone = true`。
- `battery_charge_state > 0` 或 `fault_lamps_on` 包含 `charge`。
- 急停、碰撞停等安全停。
- planning/routing 都无法给出巡逻任务证据。

强巡逻证据：

- `planner_running > 0`，或
- `total_loop_sum > 0 && total_refline_sum > 0` 且当前 loop/refline 有效，或
- `current_path_string_ids.length > 0`，或
- routing 有有效路线位置，且 planning 有路线进度。

车速为 0 不直接排除。若存在巡逻任务证据且未充电/未安全停，应判为“巡逻任务中暂停/等待/避障”，允许低频采集；若已经到终点或长时间 idle，应判为“巡逻完成或空闲”，不采集。

建议状态枚举：

- `patrol_active_moving`
- `patrol_active_stopped`
- `patrol_task_stopped_or_waiting`
- `patrol_completed_or_idle`
- `charging_or_charging_area`
- `not_patrol`
- `unknown`

正式采集只允许前三类，并且必须定位可靠。

## 已落实的采集门控

1. `backend/park-pcm.js` 已增加 `classifyCrowdPatrolCaptureState(vehicle, toolResults, options)`。
2. `runCrowdDemoCapture()` 调 `camera.capture` 前会先并发只读调用：
   - `status.planning`
   - `status.routing`
   - `status.can`
3. `force = true` 不能绕过巡逻判定，只能跳过距离/冷却门控。
4. 非巡逻、状态未知、充电、安全停、心跳过期、定位不可用/不可靠时，接口返回 `skipped: true`，不会调用 `camera.capture`。
5. 正式样本和每张图片 sidecar metadata 都会写入 `patrol_state`。
6. 只有 `patrol_active_moving`、`patrol_active_stopped`、`patrol_task_stopped_or_waiting` 三类允许抓拍。

## 下一步建议

1. 给 `/api/park-pcm/crowd/vehicles` 增加“只读巡逻状态预判”能力，前端车辆下拉可直接过滤/标注可采集车辆。
2. 接入图片识别 pipeline：人数、男女、年龄段、高矮、密度、场景标签。
3. 用 `position.gaode_longitude/gaode_latitude` 对接高德热力图。
4. 根据实际巡逻速度和点位密度，把默认距离门槛从 `60m` 调成生产值。
