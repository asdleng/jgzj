const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AUTH_STORE_VERSION,
  OPERATOR_ALL_PERMISSIONS,
  PERMISSIONS,
  createAuthStore
} = require('./auth-store');

function legacyState() {
  return {
    version: 2,
    users: {
      viewer: {
        username: 'viewer',
        display_name: 'viewer',
        active: true,
        super_admin: false,
        email: 'viewer@example.com',
        email_verified: true,
        email_verified_at: '2026-01-01T00:00:00.000Z',
        permissions: ['site:private:view', 'vehicle:read', 'vehicle:control', 'mapping:run']
      }
    },
    sessions: {},
    email_verification_tokens: {},
    deleted_users: {},
    audit: []
  };
}

test('auth store migrates legacy capability access without regranting revoked pages', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jgzj-auth-page-permissions-'));
  const storePath = path.join(root, 'auth-store.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(storePath, JSON.stringify(legacyState()), 'utf8');

  const migratedStore = createAuthStore({ storePath });
  await migratedStore.ensureLoaded();
  const migrated = migratedStore.state.users.viewer.permissions;
  assert.equal(migratedStore.state.version, AUTH_STORE_VERSION);
  assert.ok(migrated.includes('page:green-management:view'));
  assert.ok(migrated.includes('page:remote-driving:view'));
  assert.ok(migrated.includes('page:cloud-mapping:view'));

  migratedStore.state.users.viewer.permissions = migrated.filter(
    (permission) => permission !== 'page:green-management:view'
  );
  await migratedStore.persist();

  const reloadedStore = createAuthStore({ storePath });
  await reloadedStore.ensureLoaded();
  assert.ok(!reloadedStore.state.users.viewer.permissions.includes('page:green-management:view'));
});

test('permission catalog exposes all page buttons and preserves audit isolation', () => {
  const pagePermissions = PERMISSIONS.filter((permission) => permission.group === '子页面');
  assert.equal(pagePermissions.length, 14);
  assert.ok(pagePermissions.some((permission) => permission.id === 'page:green-management:view'));
  assert.ok(
    pagePermissions.some(
      (permission) => permission.id === 'page:end-to-end-autonomous-driving:view'
    )
  );
  assert.ok(!OPERATOR_ALL_PERMISSIONS.includes('audit:read'));
  assert.ok(!OPERATOR_ALL_PERMISSIONS.includes('page:operation-history:view'));
  assert.ok(!OPERATOR_ALL_PERMISSIONS.includes('page:end-to-end-autonomous-driving:view'));
});
