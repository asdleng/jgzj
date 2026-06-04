# 3DGS 车端图像-位姿包要求

目标：云端训练 3DGS 时，每一张相机图像都必须有与该图像时间戳对应的相机位姿。不要假设 camera1/2/3/4 的同一个 `index` 是同一时刻。

## 核心原则

1. 四路相机可以不同步。
2. 每路相机自己按关键帧逻辑采集即可。
3. 云端以 `image.header.stamp` / `image.ts_unix` 为准做数据检查、四路最近邻显示和后续插值。
4. `index` 只能表示该相机自己的落盘序号，不能作为四路同步 key。
5. 训练用 pose 必须对应单张图像的时间戳，不能把某一路或某个近似同步帧的 pose 套给其他相机。

## 推荐上传包结构

```text
manifest.json
pose_history.jsonl
shared_context/pose_history.jsonl
shared_context/pointcloud_context.bag
shared_context/pointcloud_context.jsonl
camera1/manifest.json
camera1/frames.jsonl
camera1/images/*.jpg
camera2/manifest.json
camera2/frames.jsonl
camera2/images/*.jpg
camera3/manifest.json
camera3/frames.jsonl
camera3/images/*.jpg
camera4/manifest.json
camera4/frames.jsonl
camera4/images/*.jpg
```

如果包体太大，继续使用现在的分块续传 `Content-Range` 方案。

## 每张图像记录必须包含

`camera*/frames.jsonl` 每行一条图像记录，字段建议如下：

```json
{
  "camera_id": "camera1",
  "index": 62,
  "image": {
    "relative_path": "images/000062_camera1.jpg",
    "topic": "/miivii_gmsl_ros/camera1/compressed",
    "header": {
      "seq": 797,
      "frame_id": "front_link",
      "stamp": {
        "secs": 1780488648,
        "nsecs": 123456789
      }
    },
    "ts_unix": 1780488648.1234567
  },
  "pose": {
    "source": "ndt_pose",
    "topic": "/ndt_pose",
    "stamp": {
      "secs": 1780488648,
      "nsecs": 120000000
    },
    "ts_unix": 1780488648.12,
    "image_pose_delta_ms": 3.456
  },
  "transforms": {
    "T_map_lidar": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
    "T_lidar_camera": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
    "T_camera_lidar": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
    "T_map_camera": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
    "T_camera_map": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]
  }
}
```

要求：

- `image.header.stamp` 或 `image.ts_unix` 必须是原始图像时间戳。
- `pose.stamp` 或 `pose.ts_unix` 必须是实际用于计算该图像位姿的 `/ndt_pose` 时间戳。
- `image_pose_delta_ms = (image_ts - pose_ts) * 1000`，正负号要保留。
- `T_map_camera` 和 `T_camera_map` 至少提供一个，最好两个都提供。
- 变换矩阵必须注明约定：列向量右乘时 `p_map = T_map_camera * p_camera`。

## 强烈建议增加 pose_history.jsonl

为了让云端可以真正按图片时间戳插值，而不是只使用车端最近邻 pose，请在包根目录增加 `pose_history.jsonl`。采集期间保存原始 `/ndt_pose` 队列即可，频率越接近原始 ROS 频率越好。

每行格式：

```json
{
  "topic": "/ndt_pose",
  "stamp": {
    "secs": 1780488648,
    "nsecs": 100000000
  },
  "ts_unix": 1780488648.1,
  "frame_id": "map",
  "child_frame_id": "lidar",
  "position": {
    "x": 1.0,
    "y": 2.0,
    "z": 0.3
  },
  "orientation": {
    "x": 0.0,
    "y": 0.0,
    "z": 0.0,
    "w": 1.0
  },
  "T_map_lidar": [[1,0,0,1],[0,1,0,2],[0,0,1,0.3],[0,0,0,1]],
  "reliable": true
}
```

云端会用：

- translation 线性插值
- rotation 四元数 SLERP
- 再结合每个相机的 `T_lidar_camera` / `T_camera_lidar`
- 得到每张图像自己的 `T_map_camera` / `T_camera_map`

## 标定信息

每个 `camera*/manifest.json` 或每条 frame 里要包含当前 FAST-Calib 的实际读取结果：

```json
{
  "camera_calibration": {
    "camera_id": "camera1",
    "width": 1920,
    "height": 1080,
    "K": [1078.63, 0, 983.532, 0, 1082.16, 739.899, 0, 0, 1],
    "D": [-0.1, 0.01, 0.0, 0.0, 0.0],
    "T_lidar_camera": [[...]],
    "T_camera_lidar": [[...]],
    "calibration_source_path": "/home/nvidia/workspace/src/auto_ad/modules/FAST-Calib/output/miivii_gmsl_camera1/single_calib_result.txt",
    "calibration_source_mtime_iso": "2026-06-04T10:00:00+08:00"
  }
}
```

## 云端打包请求

云端会继续调用：

```json
{
  "type": "tool.call",
  "tool": "3dgs.capture.package",
  "args": {
    "session_id": "SESSION_ID",
    "include_base64": false,
    "include_pose_history": true,
    "pose_interpolation": "timestamp",
    "upload_url": "https://<cloud-host>/api/three-dgs/image-pose-upload/<token>",
    "status_url": "https://<cloud-host>/api/three-dgs/image-pose-upload/<token>/status",
    "method": "POST",
    "chunk_size_bytes": 33554432
  }
}
```

如果车端已经为每张图提供 `pose_context.previous/following` 和插值后的 `transforms.T_map_camera`，云端训练时直接使用每帧的 `T_map_camera` / `T_camera_map`，不会再按最近邻 `/ndt_pose` 重新配位姿。

## 云端开始采集请求

云端按钮应以车辆级 session 一次启动所有 enabled 且标定正确的相机：

```json
{
  "type": "tool.call",
  "tool": "3dgs.capture.start",
  "args": {
    "camera": "all",
    "pose_topic": "/ndt_pose",
    "pointcloud_topic": "/rslidar_points32",
    "min_translation_m": 0.5,
    "min_rotation_deg": 10.0,
    "min_interval_s": 0.2,
    "max_pose_gap_ms": 100,
    "pose_interpolation_delay_s": 0.25,
    "interpolation_timeout_s": 1.0,
    "pointcloud_context_max_gap_ms": 150,
    "save_pointcloud_context": true,
    "duration_s": 0,
    "max_frames": 0
  }
}
```

云端规整 COLMAP 数据时的约定：

- 优先使用每条 frame record 里的 `transforms.T_camera_map`。
- 如果只有 `transforms.T_map_camera`，云端求逆得到 COLMAP world-to-camera。
- 不使用四路相机 index 做同步。
- 不再用云端最近邻 `/ndt_pose` 重算训练位姿。

## 验收标准

云端收到包后会检查：

- 每张图有 `image.ts_unix` 或 `image.header.stamp`。
- 每张图有 `T_map_camera` 或可由 `pose_history + extrinsic` 计算出来。
- 每路相机独立统计帧数，不要求四路帧数相同。
- 四路预览按时间最近邻显示，并显示 `Δt`，不会使用 `index` 作为同步依据。
- `image_pose_delta_ms` p90 建议低于 50ms；运动较快时越低越好。
