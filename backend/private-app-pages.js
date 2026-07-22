'use strict';

const PRIVATE_APP_PAGES = [
  {
    href: '/app/robot-ai-workbench',
    label: 'AI工作台',
    file: 'app/robot-ai-workbench/index.html',
    permission: 'page:robot-ai-workbench:view',
    legacyPermissions: ['ai:chat', 'ai:detect', 'ai:history:read']
  },
  {
    href: '/app/yolo-label-review',
    label: 'YOLO标签',
    file: 'app/yolo-label-review/index.html',
    permission: 'page:yolo-label-review:view',
    legacyPermissions: ['ai:yolo:review']
  },
  {
    href: '/app/cloud-operations',
    label: '云端运维',
    file: 'app/cloud-operations/index.html',
    permission: 'page:cloud-operations:view',
    legacyPermissions: ['vehicle:read', 'runtime:read']
  },
  {
    href: '/app/remote-driving',
    label: '远程驾驶',
    file: 'app/remote-driving/index.html',
    permission: 'page:remote-driving:view',
    legacyPermissions: ['vehicle:control']
  },
  {
    href: '/app/cloud-operations-test',
    label: '云端运维(测试)',
    file: 'app/cloud-operations-test/index.html',
    permission: 'page:cloud-operations-test:view',
    legacyPermissions: ['vehicle:read', 'runtime:read']
  },
  {
    href: '/app/lidar-relocalization',
    label: '激光重定位',
    file: 'app/lidar-relocalization/index.html',
    permission: 'page:lidar-relocalization:view',
    legacyPermissions: ['vehicle:read']
  },
  {
    href: '/app/park-crowd',
    label: '园区人流',
    file: 'app/park-crowd/index.html',
    permission: 'page:park-crowd:view',
    legacyPermissions: ['vehicle:read']
  },
  {
    href: '/app/green-management',
    label: '绿化管理',
    file: 'app/green-management/index.html',
    permission: 'page:green-management:view',
    legacyPermissions: ['vehicle:read']
  },
  {
    href: '/app/vehicle-devops',
    label: '车辆代码',
    file: 'app/vehicle-devops/index.html',
    permission: 'page:vehicle-devops:view',
    legacyPermissions: ['vehicle:code:read', 'vehicle:code:write']
  },
  {
    href: '/app/end-to-end-autonomous-driving',
    label: '端到端自动驾驶',
    file: 'app/end-to-end-autonomous-driving/index.html',
    permission: 'page:end-to-end-autonomous-driving:view',
    legacyPermissions: []
  },
  {
    href: '/app/cloud-mapping',
    label: '云端建图',
    file: 'app/cloud-mapping/index.html',
    permission: 'page:cloud-mapping:view',
    legacyPermissions: ['mapping:run']
  },
  {
    href: '/app/three-dgs',
    label: '3DGS',
    file: 'app/three-dgs/index.html',
    permission: 'page:three-dgs:view',
    legacyPermissions: ['three-dgs:run']
  },
  {
    href: '/app/operation-history',
    label: '操作记录',
    file: 'app/operation-history/index.html',
    permission: 'page:operation-history:view',
    legacyPermissions: ['audit:read']
  },
  {
    href: '/app/distributed-map-management',
    label: '地图管理',
    file: 'app/distributed-map-management/index.html',
    permission: 'page:distributed-map-management:view',
    legacyPermissions: ['vehicle:path:write']
  }
];

const PRIVATE_APP_PAGE_ALIASES = [
  {
    href: '/app/park-pcm',
    file: 'app/park-pcm/index.html',
    permission: 'page:park-crowd:view'
  },
  {
    href: '/app/intelligent-ai-dialogue',
    file: 'app/robot-ai-workbench/index.html',
    permission: 'page:robot-ai-workbench:view'
  },
  {
    href: '/app/edge-cloud-ai-inspection',
    file: 'app/robot-ai-workbench/index.html',
    permission: 'page:robot-ai-workbench:view'
  }
];

const PAGE_PERMISSIONS = PRIVATE_APP_PAGES.map((page) => ({
  id: page.permission,
  label: page.label,
  group: '子页面'
}));

const PAGE_PERMISSION_IDS = PAGE_PERMISSIONS.map((item) => item.id);

function pagePaths(href) {
  return [href, `${href}/`];
}

function buildPrivateNavigationItems() {
  return PRIVATE_APP_PAGES.map((page) => ({
    href: page.href,
    label: page.label,
    permissions: [page.permission]
  }));
}

function buildProtectedAppPages() {
  return [...PRIVATE_APP_PAGES, ...PRIVATE_APP_PAGE_ALIASES].map((page) => ({
    paths: pagePaths(page.href),
    file: page.file,
    permissions: [page.permission]
  }));
}

function inferLegacyPagePermissions(permissionIds) {
  const granted = new Set(Array.isArray(permissionIds) ? permissionIds : []);
  return PRIVATE_APP_PAGES
    .filter((page) => page.legacyPermissions.some((permission) => granted.has(permission)))
    .map((page) => page.permission);
}

module.exports = {
  PAGE_PERMISSIONS,
  PAGE_PERMISSION_IDS,
  PRIVATE_APP_PAGES,
  PRIVATE_APP_PAGE_ALIASES,
  buildPrivateNavigationItems,
  buildProtectedAppPages,
  inferLegacyPagePermissions
};
