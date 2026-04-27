export const siteUrl = "https://jiguangzhijie.top";
export const siteName = "深圳吉光智界科技有限公司";
export const siteDescription =
  "吉光智界专注安防巡逻、园区自动驾驶、端云协同 AI 检测、智能交互与云端运维的一体化机器人方案。";

export const navigationItems = [
  { href: "/", label: "安防巡逻行业爆发" },
  { href: "/l4-autonomous-driving", label: "L4级园区自动驾驶" },
  { href: "/edge-cloud-ai-inspection", label: "端云协同AI检测" },
  { href: "/intelligent-ai-dialogue", label: "智能AI对话交互" },
  { href: "/cloud-operations", label: "云端智能运维" },
  { href: "/cloud-mapping", label: "大规模云端建图" },
  { href: "/distributed-map-management", label: "分布地图云端统一管理" },
  { href: "/cases-awards", label: "案例与奖项" }
];

export const contactInfo = {
  email: "jgauto402@163.com",
  phone: "暂不公开",
  address: "广东省深圳市坪山区新能源汽车产业园区2期"
};

export const securityPainPoints = [
  "人力短板显现：夜间偏远巡逻人力不足，新人培训成本高，断层严重。",
  "效率问题突出：信息滞后误差大，盲区多、处置慢，恶劣环境影响安全。",
  "传统技术瓶颈：架构弱智能，功能单一，复杂需求下体验差，成本高。",
  "缺乏营收模式：难以变现，无附加收益，传统设备投入产出比低。"
];

export const securityDrivers = [
  {
    title: "劳动力成本持续上升",
    text: "2024 年深圳平均月可支配收入 6760 元，保安工资普遍不低于当地平均水平，安防人力成本年增约 5%，2025–2027 年将迎来机器人替代临界点。"
  },
  {
    title: "中国市场增长空间巨大",
    text: "2024 年中国安防服务市场规模达 2710 亿元，人防占比 67.34%，年增速超 10%，但中国仅占全球安防市场 20%，增长潜力显著。"
  },
  {
    title: "全球万亿级蓝海赛道",
    text: "2023 年全球安防市场达 4050 亿美元，服务收入占比约 80%。全球安防巡逻机器人整体市场规模约 1 万亿人民币，第四空间需求大、增长快、空白多。"
  }
];

export const industryPlaceholders = [
  {
    title: "典型安防事件分布",
    text: "素材待补充：后续可放巡逻热点、时间段分布、人工漏检痛点等图表。"
  },
  {
    title: "行业增长趋势",
    text: "素材待补充：后续可放市场规模、落地项目增长、场景渗透率等数据。"
  },
  {
    title: "客户决策关注点",
    text: "素材待补充：后续可放成本、风险、联动能力、运维能力等决策因素。"
  }
];

export const baizeModes = [
  "安防巡逻",
  "异常识别",
  "智能检测",
  "园区导览",
  "移动宣传",
  "应急提醒",
  "多任务协同"
];

export const baizeSpecs = [
  { item: "长×宽×高", value: "1900 × 1200 × 1850 mm" },
  { item: "整车质量", value: "450 kg" },
  { item: "最大爬坡", value: "20%" },
  { item: "最大车速", value: "30 km/h" },
  { item: "续航里程", value: "80 km" },
  { item: "作业时间", value: "6-8 h" },
  { item: "感知范围", value: "100 m / 360°" },
  { item: "感知类型", value: ">30 种" },
  { item: "激光雷达", value: "3 颗（前后环视）" },
  { item: "视觉", value: "4 颗（前后环视）" },
  { item: "自动驾驶功能", value: "封闭园区自主行驶" },
  { item: "软件更新", value: "SOTA + FOTA" }
];

export const autonomousDrivingStacks = [
  {
    title: "感知",
    text: "多激光雷达、多视觉与异构传感融合，覆盖静态障碍、动态目标、车道边界与通行空间。"
  },
  {
    title: "定位",
    text: "基于激光、视觉与地图的多源融合定位，适应园区、街区、公园等复杂封闭与半封闭道路。"
  },
  {
    title: "决策规划",
    text: "支持巡逻、停靠、避障、让行、调头、绕行等策略编排，兼顾安全冗余与效率。"
  },
  {
    title: "控制",
    text: "完成纵向与横向控制闭环，满足低速自动驾驶在复杂场景下的平顺性和通过性要求。"
  }
];

export const autonomousDrivingHighlights = [
  "支持园区内自主巡逻、定点任务、移动宣传与服务停靠",
  "端云协同更新地图、策略与任务计划，方便后续批量运维",
  "可与安防事件、广播、AI 检测、问答服务形成统一执行链路"
];

export const visualScenes = [
  {
    title: "红岗公园",
    src: "/assets/visual-honggang-park.bmp",
    alt: "红岗公园车端 AI 可视化界面"
  },
  {
    title: "万达广场",
    src: "/assets/visual-wanda-plaza.bmp",
    alt: "万达广场车端 AI 可视化界面"
  },
  {
    title: "西丽街道",
    src: "/assets/visual-xili-street.bmp",
    alt: "西丽街道车端 AI 可视化界面"
  }
];

export const dialogueHighlights = [
  "支持端云协同文本问答、身份切换、知识注入与多轮上下文。",
  "可面向不同项目地点切换车端知识画像，例如 car-a、car-b、car-e 等。",
  "支持流式回复、云端对话、OpenClaw 运维助手与后续语音扩展。"
];

export const cloudOpsHighlights = [
  "通过自然语言理解车辆状态、项目配置和现场问题。",
  "可作为云端运维入口，接管查询、诊断、策略调整和远程协助。",
  "后续可继续接入云平台截图、任务看板、告警拓扑和车辆健康报告。"
];

export const cloudOpsPlaceholders = [
  "云平台总览大屏占位",
  "车辆状态拓扑占位",
  "远程任务调度占位",
  "告警闭环工单占位"
];

export const cases = [
  {
    title: "场馆活动服务",
    text: "在大型场馆提供接待引导与现场信息触达。",
    img: "/assets/s20_3634d8e375c5.jpg"
  },
  {
    title: "园区巡逻与导览",
    text: "在人流密集区域执行巡逻和路线引导。",
    img: "/assets/s20_d85bf38d2a8c.jpg"
  },
  {
    title: "夜间公共空间服务",
    text: "在夜间场景持续输出巡查与服务能力。",
    img: "/assets/s20_897c068b5bac.jpg"
  },
  {
    title: "校园与商业综合体",
    text: "结合导览、播报和互动，强化用户体验。",
    img: "/assets/s20_a32837c09c93.png"
  }
];

export const awards = [
  "获国际设计大奖认可（MUSE）",
  "获金芦苇优秀产品设计奖",
  "获无人车行业奖项与产品奖项",
  "获生态合作伙伴认证（封闭场景）"
];
