const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PAGE_PERMISSIONS,
  PRIVATE_APP_PAGES,
  buildPrivateNavigationItems,
  buildProtectedAppPages,
  inferLegacyPagePermissions
} = require('./private-app-pages');

test('canonical workspaces drive permissions, navigation, and protected routes', () => {
  const navigation = buildPrivateNavigationItems();
  const protectedPages = buildProtectedAppPages();
  const canonicalHrefs = PRIVATE_APP_PAGES.map((page) => page.href);

  assert.equal(PRIVATE_APP_PAGES.length, 14);
  assert.equal(PAGE_PERMISSIONS.length, PRIVATE_APP_PAGES.length);
  assert.equal(new Set(canonicalHrefs).size, canonicalHrefs.length);
  assert.equal(new Set(PAGE_PERMISSIONS.map((item) => item.id)).size, PAGE_PERMISSIONS.length);
  assert.deepEqual(navigation.map((item) => item.href), canonicalHrefs);
  navigation.forEach((item) => {
    assert.equal(item.permissions.length, 1);
    assert.match(item.permissions[0], /^page:.+:view$/);
  });
  canonicalHrefs.forEach((href) => {
    assert.ok(protectedPages.some((page) => page.paths.includes(href)), `${href} is protected`);
  });
  assert.ok(navigation.some((item) => item.href === '/app/cloud-mapping'));
  assert.ok(navigation.some((item) => item.href === '/app/end-to-end-autonomous-driving'));
  assert.ok(
    protectedPages.some((page) => page.paths.includes('/app/end-to-end-autonomous-driving'))
  );
  assert.ok(protectedPages.some((page) => page.paths.includes('/app/park-pcm')));
});

test('legacy capabilities infer the same page access once', () => {
  const inferred = new Set(inferLegacyPagePermissions([
    'vehicle:read',
    'vehicle:control',
    'mapping:run',
    'audit:read'
  ]));

  assert.ok(inferred.has('page:remote-driving:view'));
  assert.ok(inferred.has('page:lidar-relocalization:view'));
  assert.ok(inferred.has('page:park-crowd:view'));
  assert.ok(inferred.has('page:green-management:view'));
  assert.ok(inferred.has('page:cloud-mapping:view'));
  assert.ok(inferred.has('page:operation-history:view'));
  assert.ok(!inferred.has('page:yolo-label-review:view'));
  assert.ok(!inferred.has('page:end-to-end-autonomous-driving:view'));
});
