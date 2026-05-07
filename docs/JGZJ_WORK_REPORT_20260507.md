# JGZJ 网站阶段性述职报告

更新时间：2026-05-07  
项目仓库：`/home/admin1/jgzj`  
仓库远端：`git@github.com:asdleng/jgzj.git`

## 一、项目定位

`jgzj` 已经不是一个单纯的品牌官网，而是一个“官网外壳 + 演示中台 + 云端能力聚合入口”的综合项目。  
它承担了三类目标：

1. 对外展示公司方案能力，形成可直接演示的多页面官网。
2. 对内聚合多条 AI / 车端 / 运维 / 建图链路，变成一个统一入口。
3. 为销售、交付、技术演示和远程联调提供可视化工作台。

当前网站已经覆盖以下核心主题：

1. 安防巡逻行业爆发
2. L4 级园区自动驾驶
3. 端云协同 AI 检测
4. 智能 AI 对话交互
5. 云端智能运维
6. 大规模云端建图
7. 分布地图云端统一管理
8. 案例与奖项

## 二、阶段划分

### 阶段 1：静态官网初始化与基础品牌页面搭建

这一阶段的目标，是先把公司从“没有对外承载页”变成“有一个能打开、能讲清楚定位和产品方向的官网”。

完成内容：

1. 初始化 `Astro + Tailwind` 前端工程。
2. 完成中文化企业官网内容替换。
3. 补齐基础 SEO、`robots.txt`、`sitemap.xml`、域名配置等静态站点要素。
4. 建立首页基础结构，包括品牌文案、企业定位、能力概览和联系方式。

这一阶段的意义：

1. 解决“没有统一展示页”的问题。
2. 让网站具备基本可访问、可部署、可传播能力。
3. 为后续接入后端和动态功能保留结构基础。

### 阶段 2：从 GitHub Pages 静态站升级到前后端一体站点

早期方案的问题是：GitHub Pages 只能托管静态文件，无法承载真正的后端服务，也无法代理聊天、运维、检测等能力。

这一阶段做的事情：

1. 引入 `backend/server.js`，让仓库变成前后端一体部署项目。
2. 让前端构建产物输出到 `dist/`，由 Node 后端统一静态托管。
3. 增加基础健康检查接口，例如 `/healthz`。
4. 打通 `/api/cloud-chat` 代理，把网页请求接到本机 AI 对话链路。
5. 增加本地 Node 20 运行时和一键启动脚本，减少环境不一致问题。

这一阶段的核心价值：

1. 把“只能展示”升级成“可交互、可接后端、可接内网服务”。
2. 为后面接 7790、7788、7789、A100 tunnel 打下统一后端入口。
3. 让 7791 官网具备真正的服务端能力。

关键文件：

1. [backend/server.js](/home/admin1/jgzj/backend/server.js)
2. [scripts/start-site.sh](/home/admin1/jgzj/scripts/start-site.sh)
3. [scripts/stop-site.sh](/home/admin1/jgzj/scripts/stop-site.sh)
4. [docs/backend-deploy.md](/home/admin1/jgzj/docs/backend-deploy.md)

### 阶段 3：官网从单页扩展为多页产品演示站

在完成前后端一体化之后，官网不再停留在“一个首页”，而是拆成多个业务主题页面，形成更适合述标、汇报、商务介绍和现场演示的结构。

新增页面方向：

1. 行业痛点与市场爆发
2. L4 自动驾驶能力
3. AI 检测能力
4. AI 对话能力
5. 云端运维能力
6. 云端建图能力
7. 分布式地图插件接入能力
8. 案例与奖项

这一阶段完成的工作包括：

1. 重构网站导航，支持多页面切换。
2. 引入统一页面骨架和主题式视觉布局。
3. 增加大量业务素材、背景图、案例图、UI 截图。
4. 将原本碎片化的功能整合到明确的产品叙事路径中。

阶段价值：

1. 让网站从“技术测试页”升级成“可作为商务讲解材料的产品官网”。
2. 每个页面可以单独聚焦一个能力主题，便于讲故事和拆方案。
3. 让产品能力和真实系统入口融合在一起，而不是只做 PPT 式静态展示。

关键页面：

1. [src/pages/index.astro](/home/admin1/jgzj/src/pages/index.astro)
2. [src/pages/l4-autonomous-driving.astro](/home/admin1/jgzj/src/pages/l4-autonomous-driving.astro)
3. [src/pages/edge-cloud-ai-inspection.astro](/home/admin1/jgzj/src/pages/edge-cloud-ai-inspection.astro)
4. [src/pages/intelligent-ai-dialogue.astro](/home/admin1/jgzj/src/pages/intelligent-ai-dialogue.astro)
5. [src/pages/cloud-operations.astro](/home/admin1/jgzj/src/pages/cloud-operations.astro)
6. [src/pages/cloud-mapping.astro](/home/admin1/jgzj/src/pages/cloud-mapping.astro)
7. [src/pages/distributed-map-management.astro](/home/admin1/jgzj/src/pages/distributed-map-management.astro)
8. [src/pages/cases-awards.astro](/home/admin1/jgzj/src/pages/cases-awards.astro)

### 阶段 4：网页端 AI 对话能力接入

这一阶段的目标，是把“网页展示”升级成“网页可直接和模型对话”，并且让对话不是死页面，而是真正接到现有 8 卡服务链路。

已完成能力：

1. 网页端云端对话组件接入。
2. 后端 `/api/cloud-chat` 代理接入 7790 文本对话链。
3. 支持流式返回和消息状态显示。
4. 支持不同车辆 / 不同项目身份切换，例如 `car-a`、`car-b`、`car-e`、`car-web`。
5. 支持清空会话、刷新页面重置等交互体验优化。
6. 支持 TTS 扩展基础结构，为后续网页音频输出保留接口位置。

这里的本质不是“网页上放一个聊天框”，而是完成以下闭环：

1. 网页输入
2. 服务端代理
3. 意图理解
4. LLM 调用
5. RAG / 项目身份注入
6. 可选 TTS
7. 结果回传到网页

关键组件与脚本：

1. [src/components/EmbeddedCloudChat.astro](/home/admin1/jgzj/src/components/EmbeddedCloudChat.astro)
2. [src/scripts/interactive-panels.js](/home/admin1/jgzj/src/scripts/interactive-panels.js)
3. [backend/server.js](/home/admin1/jgzj/backend/server.js)

阶段价值：

1. 网站开始直接承接真实 AI 能力，而不是只有静态介绍。
2. 让客户、同事、合作方可以直接在网页上体验问答。
3. 与车端身份知识库联动，体现“同一套底层能力可服务多个项目”的可配置性。

### 阶段 5：端云协同 AI 检测能力接入

这一阶段完成了网站里非常关键的一条演示能力：网页上传图片、输入事件名称，模型返回 “是 / 否” 判断结果。

当前已经形成两条检测能力：

1. 基于本机 `Qwen3-VL-2B` 的网页检测与车端 WebSocket 检测链。
2. 基于 A100 tunnel 的 `Qwen3.6-27B-MM` 多模态检测链。

已完成内容：

1. AI 检测页面可上传图片。
2. 输入事件名称即可进行二分类判断。
3. 若不自定义提示词，则使用默认提示词模板。
4. 检测结果在页面中直接展示，适合快速验证事件识别能力。
5. 将车端检测归档结果接回网页，形成“历史 AI 检测”能力。
6. 历史记录支持分页、图片预览、详情查看、按地点筛选。
7. 检测页文案上强调“车端小模型 + 云端大模型”的数据闭环与协同逻辑。

多模态检测接入的进一步升级：

1. 增加 `Qwen3.6-27B-MM` 独立检测框。
2. 通过 `127.0.0.1:18001 -> A100:8001` tunnel 走多模态大模型。
3. 后端提供 `/api/qwen36-mm-check`。
4. 将网页上传检测结果写入 AI 检测归档目录和 SQLite，和历史浏览能力打通。

关键模块：

1. [src/components/EmbeddedAiCheckHistory.astro](/home/admin1/jgzj/src/components/EmbeddedAiCheckHistory.astro)
2. [src/components/EmbeddedQwen36MmCheck.astro](/home/admin1/jgzj/src/components/EmbeddedQwen36MmCheck.astro)
3. [src/pages/edge-cloud-ai-inspection.astro](/home/admin1/jgzj/src/pages/edge-cloud-ai-inspection.astro)
4. [backend/server.js](/home/admin1/jgzj/backend/server.js)

阶段价值：

1. 网站不再只是“对话展示”，而是具备真正的图像理解演示能力。
2. 把车端历史检测归档、云端大模型复核、网页演示三件事串起来。
3. 能直接拿去做算法效果验证、场景演示和客户沟通。

### 阶段 6：智能 AI 对话交互页面产品化

这一阶段的重点，不只是“能聊天”，而是把整个车端交互链路变成一个可解释的展示页面。

做过的工作：

1. 明确展示 `ASR -> LLM -> TTS` 智能交互闭环。
2. 在页面中加入不同项目地点的车端 UI 可视化截图。
3. 支持网页端大框交互体验，而不是窄小测试框。
4. 支持不同车端身份知识切换。
5. 支持 `Qwen3.6 27B` 文本聊天入口，形成新的高质量大模型体验位。

关键组件：

1. [src/components/EmbeddedQwen36Chat.astro](/home/admin1/jgzj/src/components/EmbeddedQwen36Chat.astro)
2. [src/components/EmbeddedCloudChat.astro](/home/admin1/jgzj/src/components/EmbeddedCloudChat.astro)
3. [src/pages/intelligent-ai-dialogue.astro](/home/admin1/jgzj/src/pages/intelligent-ai-dialogue.astro)

阶段价值：

1. 从“技术接口接通”升级成“可讲清楚完整产品交互闭环”。
2. 让外部人员看到不仅能问答，而且车端 UI、地图、字幕、态势感知都能承载。
3. 为后续语音播报、音频输出、车屏联动保留展示位置。

### 阶段 7：云端智能运维工作台建设

这是整个网站里系统性最强、工程量也很大的部分之一。

目标不是做一个普通聊天框，而是把“车辆状态查看、工具调用、自然语言运维、服务器侧节点重启、实时 telemetry 监控”统一成一个云端工作台。

已完成的几层能力：

#### 7.1 车端状态拉取与工具调用

通过 `cloud-agent` 对接车端 `auto_ad_ai_bridge`，网页可对单车做：

1. 单车详情查看
2. 工具列表查看
3. 健康快照
4. 云端连通检查
5. 主控探测
6. ROS 总览
7. 系统快照
8. 整车快照
9. 相机状态
10. 相机抓拍
11. 上传链路检查
12. 定位状态
13. 底盘 CAN 状态
14. 规划状态
15. Routing 状态
16. 障碍处理预览
17. 路线列表
18. 地图预览
19. 防撞梁停车复位
20. 车身控制，例如广告屏、前照灯、氛围灯、转向灯

#### 7.2 telemetry 实时可视化

接入车端周期上报 telemetry 后，网站可以展示：

1. 在线车辆数量
2. 当前车辆
3. 最近上报时间
4. 工具数量
5. ROS 规模
6. Media 与主控的 CPU / 内存 / 磁盘
7. 关键节点在线状态
8. 关键话题在线状态
9. 车速、电量、急停、碰撞停等关键车辆状态

这一部分把网站从“点按钮查一次”升级成“页面持续刷新、持续看态势”的运维大盘。

#### 7.3 自然语言运维

在工具按钮之外，又构建了一层自然语言运维入口：

1. 网页可直接向 OpenClaw 发送自然语言问题。
2. 工具按钮结果可插入当前对话上下文。
3. 支持逐条进度展示和工具执行结果沉淀。
4. 支持登录鉴权后再开放更高权限控制。
5. 实现“未登录可看状态、已登录可聊天和控制”的权限分层。

#### 7.4 登录保护

为了避免 OpenClaw / 运维能力被未授权外部访问，增加了登录保护：

1. 未登录用户可看只读信息。
2. 已登录用户可做自然语言运维和控制类操作。
3. 已接入账号示例：`asdleng`、`jgauto402`。

#### 7.5 服务器侧运行态和重启控制

除了车端运维，还增加了“本机服务运行态”和“重启控制”模块：

1. 监控 7790、7791、Qwen3.6 tunnel、OpenClaw gateway、AI 检测链等本机节点。
2. 展示每个节点的本地端口、公网映射、健康检查、进程 / systemd 状态。
3. 支持统一重启某些服务。

关键模块：

1. [src/components/EmbeddedCloudOpsConsole.astro](/home/admin1/jgzj/src/components/EmbeddedCloudOpsConsole.astro)
2. [src/components/EmbeddedCloudOpsRuntime.astro](/home/admin1/jgzj/src/components/EmbeddedCloudOpsRuntime.astro)
3. [src/pages/cloud-operations.astro](/home/admin1/jgzj/src/pages/cloud-operations.astro)
4. [src/scripts/cloud-ops-runtime.js](/home/admin1/jgzj/src/scripts/cloud-ops-runtime.js)
5. [src/scripts/interactive-panels.js](/home/admin1/jgzj/src/scripts/interactive-panels.js)
6. [backend/runtime-control.js](/home/admin1/jgzj/backend/runtime-control.js)
7. [backend/server.js](/home/admin1/jgzj/backend/server.js)

阶段价值：

1. 让网站从“销售展示页”升级为“运维中台入口”。
2. 让不同角色都能使用网站：销售看演示、研发看状态、运维做排查、管理层看能力闭环。
3. 把车端状态、模型服务、本机节点和网页能力统一到一个入口里。

### 阶段 8：分布地图云端统一管理

这一阶段解决的是一个非常实际的问题：车端已经有地图编辑插件，但它运行在车上，云端如何统一查看和操作。

已完成方案：

1. 通过车端 `map_editor.start`、`map_editor.status`、`map_editor.http` 工具，把车端插件嵌入到官网页面。
2. 通过云端代理 `GET / POST` 请求，把浏览器请求转成 `tool.call map_editor.http`。
3. 支持代理 HTML、JS、CSS、JSON、点云二进制数据。
4. 增加 `max_response_bytes` 和 `timeout_s` 调整，解决大路径、大地图加载失败问题。
5. 支持查看和编辑边界、路径、点云地图。
6. 已适配路径预览、新建路径、删除路径等新接口白名单。

这里本质上做的是“把车端本地网页插件，经由云端桥接，挂进总部官网里”。

关键页面和后端：

1. [src/pages/distributed-map-management.astro](/home/admin1/jgzj/src/pages/distributed-map-management.astro)
2. [backend/server.js](/home/admin1/jgzj/backend/server.js)

阶段价值：

1. 云端不需要单独再开发一套地图编辑器前端。
2. 可以复用车端已有插件能力。
3. 将“单车本地工具”升级成“总部统一入口”。

### 阶段 9：大规模云端建图页面

除了单车地图编辑器，还做了一个独立的“大规模云端建图”能力页。

主要功能：

1. 登录鉴权
2. 上传 bag
3. 触发建图脚本
4. 追踪建图阶段状态
5. 下载建图结果
6. 清理上传包或结果包

这个模块更偏“任务式云端计算”，与单车地图插件不同。

关键模块：

1. [src/pages/cloud-mapping.astro](/home/admin1/jgzj/src/pages/cloud-mapping.astro)
2. [backend/cloud-mapping.js](/home/admin1/jgzj/backend/cloud-mapping.js)

阶段价值：

1. 把原本离散的建图脚本包进网页登录流程中。
2. 让建图变成“可视化任务”，而不是“手敲命令”。
3. 强化网站作为技术交付中台的属性。

### 阶段 10：A100 大模型与 tunnel 管理接入

这一阶段的关键是：网站不只使用本机 4090 资源，也接入了 A100 大模型能力，并把这件事工程化。

已完成的事情：

1. 建立文本 tunnel：`127.0.0.1:18000 -> A100:8000`
2. 建立多模态 tunnel：`127.0.0.1:18001 -> A100:8001`
3. 使用 systemd 管理 tunnel，而不是临时 tmux 进程。
4. 对网站开放：
   - `/api/qwen36-health`
   - `/api/qwen36-chat`
   - `/api/qwen36-mm-check`
5. 将 Qwen3.6 27B 文本能力和 Qwen3.6 27B-MM 图文能力都纳入官网。
6. 将 tunnel 状态纳入 runtime-control 监控范围。

阶段价值：

1. 把“远端大模型资源”稳定接入本机网站。
2. 让网站具备更强的文本与多模态能力。
3. 避免临时人工维护 tunnel，提升稳定性和交接可维护性。

## 三、当前网站模块说明

### 1. 页面层

页面层负责“讲产品、承载交互、组织入口”。

当前页面作用如下：

1. `/`
   作用：讲行业背景、痛点、市场空间与公司切入点。
2. `/l4-autonomous-driving`
   作用：讲自动驾驶平台、感知、定位、规划、控制以及整车参数。
3. `/edge-cloud-ai-inspection`
   作用：讲车端小模型和云端大模型协同，并提供图片检测体验与历史回看。
4. `/intelligent-ai-dialogue`
   作用：讲 ASR-LLM-TTS 交互闭环，并保留网页端大模型体验入口。
5. `/cloud-operations`
   作用：汇总车辆运维、自然语言运维、运行态监控和服务重启能力。
6. `/cloud-mapping`
   作用：做大规模云端建图任务管理。
7. `/distributed-map-management`
   作用：接入车端地图编辑器插件做统一代理。
8. `/cases-awards`
   作用：展示案例与奖项，承担对外背书作用。

### 2. 组件层

组件层负责“可复用的交互面板和展示单元”。

当前核心组件：

1. `EmbeddedCloudChat.astro`
   作用：基础云端对话体验。
2. `EmbeddedQwen36Chat.astro`
   作用：Qwen3.6 27B 文本聊天入口。
3. `EmbeddedAiCheckHistory.astro`
   作用：AI 检测主面板 + 历史检测查看。
4. `EmbeddedQwen36MmCheck.astro`
   作用：Qwen3.6 27B-MM 图文检测面板。
5. `EmbeddedCloudOpsConsole.astro`
   作用：车辆运维、自然语言运维总控台。
6. `EmbeddedCloudOpsRuntime.astro`
   作用：本机服务运行态与重启控制面板。
7. `SiteLayout.astro`
   作用：统一页面骨架。
8. `Section.astro`
   作用：统一版心、区块和段落包装。

### 3. 脚本层

脚本层负责“前端交互逻辑和状态管理”。

当前核心脚本：

1. `interactive-panels.js`
   作用：
   - 聊天面板
   - Qwen3.6 文本面板
   - Qwen3.6 多模态检测面板
   - AI 检测历史列表
   - OpenClaw / 云端运维交互
   - 图片上传预览
   - 流式消息处理
   - 结果插入和上下文串联
2. `cloud-ops-runtime.js`
   作用：
   - 轮询运行态
   - 状态卡片渲染
   - 重启动作发送
   - systemd / 进程健康信息显示

### 4. 后端层

后端层负责“对外统一接口、对内聚合外部能力”。

当前三大核心后端模块：

1. `backend/server.js`
   作用：
   - 静态站点托管
   - AI 对话代理
   - OpenClaw 登录和会话代理
   - cloud-agent 工具调用代理
   - AI 检测历史查询
   - Qwen3.6 文本 / 多模态接口
   - 地图编辑器代理
   - 云端建图和运行态子模块注册
2. `backend/runtime-control.js`
   作用：
   - 监控本机关键服务
   - 做端口检查和 systemd / 进程检查
   - 提供运行态汇总
   - 提供部分服务的统一重启入口
3. `backend/cloud-mapping.js`
   作用：
   - 管理 bag 上传
   - 管理建图状态
   - 启动建图脚本
   - 提供结果下载和清理能力

## 四、当前依赖链路说明

### 1. 7791 官网

链路：

`浏览器 -> idtrd:7791 -> 本机 8888 -> 后端聚合接口 / 静态页面`

### 2. 7790 对话

链路：

`网页 /api/cloud-chat -> 8050 -> intent / LLM / TTS 链`

### 3. 7788 云端运维

链路：

`网页 -> backend/server.js -> cloud-agent:8000 -> 车端 auto_ad_ai_bridge`

### 4. 7789 车端 AI 检测

链路：

`车端 / 独立调用 -> 8794 -> 8012 vLLM`

### 5. Qwen3.6 文本与多模态

链路：

1. 文本：`网页 -> /api/qwen36-chat -> 18000 tunnel -> A100:8000`
2. 多模态：`网页 -> /api/qwen36-mm-check -> 18001 tunnel -> A100:8001`

## 五、阶段成果总结

到目前为止，这个仓库已经完成了从“一个静态官网模板”到“一个可演示、可运维、可接车、可接大模型、可接建图任务”的升级。

已经形成的成果，不是零散功能，而是几条完整的产品链：

1. 品牌官网链
2. 网页对话链
3. 图像检测链
4. 云端运维链
5. 车端地图插件桥接链
6. 云端建图任务链
7. A100 大模型接入链

这些链路共同构成了一个总部侧可视化中台入口。

## 六、当前版本的直接用途

现在这个网站可以直接用于：

1. 对外销售演示
2. 述职汇报
3. 领导参观展示
4. 远程项目联调
5. 车辆状态查看
6. AI 检测验证
7. 大模型对话体验
8. 车端插件远程接入
9. 建图任务下发与结果管理

## 七、后续建议

下一阶段如果继续推进，建议按下面顺序做：

1. 把运维与检测接口进一步权限分层。
2. 将更多 systemd 服务正式纳入统一 runtime-control。
3. 对地图编辑和建图任务加入更细的审计记录。
4. 把 AI 检测和运维结果沉淀成正式报表。
5. 完成 `jiguangzhijie.top` 的正式 80/443 域名入口切换。
6. 为关键模块补充更明确的自动化回归验证。

## 八、结论

`jgzj` 当前已经具备“官网展示 + AI 演示 + 运维入口 + 工具聚合”的复合能力。  
它的价值不在于页面数量，而在于把分散在 8 卡服务器、本机服务、A100、大模型、车端插件和车端运维工具之间的能力，收敛成了一个统一网页入口。

这意味着后续无论做述职、售前演示、远程联调，还是做总部运维中台扩展，都已经有了一个可继续迭代的基础盘。

