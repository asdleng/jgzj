const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const PERMISSIONS = [
  { id: 'site:private:view', label: '查看非公开页面', group: '网站' },
  { id: 'ai:chat', label: '体验 AI 对话', group: 'AI' },
  { id: 'ai:detect', label: '体验 AI 检测', group: 'AI' },
  { id: 'ai:history:read', label: '查看 AI 检测历史', group: 'AI' },
  { id: 'vehicle:read', label: '查看车辆状态', group: '车辆' },
  { id: 'vehicle:control', label: '控车与车端工具', group: '车辆' },
  { id: 'vehicle:path:write', label: '修改车端路径/地图', group: '车辆' },
  { id: 'vehicle:code:read', label: '查看车端代码状态', group: '代码' },
  { id: 'vehicle:code:write', label: '更新/编译车端代码', group: '代码' },
  { id: 'mapping:run', label: '云端建图', group: '地图' },
  { id: 'three-dgs:run', label: '3DGS 场景训练', group: '地图' },
  { id: 'runtime:read', label: '查看服务器节点', group: '运维' },
  { id: 'runtime:restart', label: '重启服务器节点', group: '运维' },
  { id: 'audit:read', label: '查看操作记录', group: '审计' }
];

const ALL_PERMISSION_IDS = PERMISSIONS.map((item) => item.id);
const REGISTERED_DEFAULT_PERMISSIONS = ['site:private:view'];
const OPERATOR_ALL_PERMISSIONS = ALL_PERMISSION_IDS.filter((permission) => permission !== 'audit:read');
const SESSION_COOKIE_NAME = 'jgzj_session';
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EMAIL_VERIFICATION_RESEND_MS = 60 * 1000;
const MAX_AUDIT_ITEMS = 500;

function nowIso() {
  return new Date().toISOString();
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidUsername(username) {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(username);
}

function isStrongEnoughPassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 128;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '')) && String(email || '').length <= 254;
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('base64url');
  return {
    method: 'scrypt',
    salt,
    hash
  };
}

function verifyPassword(password, passwordHash) {
  if (!passwordHash || passwordHash.method !== 'scrypt') {
    return false;
  }
  const next = hashPassword(password, passwordHash.salt);
  return timingSafeEqualText(next.hash, passwordHash.hash);
}

function parseCookies(cookieHeader) {
  const jar = {};
  String(cookieHeader || '')
    .split(';')
    .forEach((part) => {
      const idx = part.indexOf('=');
      if (idx <= 0) {
        return;
      }
      const key = decodeURIComponent(part.slice(0, idx).trim());
      const value = decodeURIComponent(part.slice(idx + 1).trim());
      if (key) {
        jar[key] = value;
      }
    });
  return jar;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAgeMs != null) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeMs / 1000))}`);
  }
  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('base64url');
}

function sanitizePermissions(permissions) {
  const allowed = new Set(ALL_PERMISSION_IDS);
  return [...new Set(Array.isArray(permissions) ? permissions : [])]
    .map((item) => String(item || '').trim())
    .filter((item) => allowed.has(item));
}

function isEmailVerified(user) {
  return Boolean(user?.email && user?.email_verified);
}

function effectivePermissions(user) {
  if (!user) {
    return [];
  }
  if (!isEmailVerified(user)) {
    return [];
  }
  if (user.super_admin) {
    return [...ALL_PERMISSION_IDS, 'admin:all'];
  }
  return sanitizePermissions(user.permissions);
}

function publicUser(user) {
  if (!user) {
    return null;
  }
  return {
    username: user.username,
    display_name: user.display_name || user.username,
    active: user.active !== false,
    super_admin: Boolean(user.super_admin),
    email: user.email || '',
    email_verified: isEmailVerified(user),
    email_verified_at: user.email_verified_at || null,
    email_verification_sent_at: user.email_verification_sent_at || null,
    permissions: sanitizePermissions(user.permissions),
    effective_permissions: effectivePermissions(user),
    created_at: user.created_at || null,
    updated_at: user.updated_at || null,
    last_login_at: user.last_login_at || null
  };
}

function createDefaultUser(username, password, options = {}) {
  const at = nowIso();
  return {
    username,
    display_name: options.display_name || username,
    active: true,
    super_admin: Boolean(options.super_admin),
    email: normalizeEmail(options.email),
    email_verified: Boolean(options.email_verified),
    email_verified_at: options.email_verified ? at : null,
    email_verification_sent_at: null,
    permissions: sanitizePermissions(options.permissions),
    password_hash: hashPassword(password),
    created_at: at,
    updated_at: at,
    last_login_at: null
  };
}

class AuthStore {
  constructor(options = {}) {
    this.storePath = path.resolve(
      options.storePath || path.join(options.rootDir || process.cwd(), '.runtime/auth-store.json')
    );
    this.cookieName = options.cookieName || SESSION_COOKIE_NAME;
    this.sessionTtlMs = Number(options.sessionTtlMs || DEFAULT_SESSION_TTL_MS);
    this.emailVerificationTtlMs = Number(
      options.emailVerificationTtlMs || process.env.JGZJ_EMAIL_VERIFICATION_TTL_MS || DEFAULT_EMAIL_VERIFICATION_TTL_MS
    );
    this.emailVerificationResendMs = Number(
      options.emailVerificationResendMs ||
        process.env.JGZJ_EMAIL_VERIFICATION_RESEND_MS ||
        DEFAULT_EMAIL_VERIFICATION_RESEND_MS
    );
    this.secureCookie = Boolean(options.secureCookie);
    this.state = null;
    this.loadPromise = null;
    this.writeLock = Promise.resolve();
  }

  async ensureLoaded() {
    if (this.state) {
      return this.state;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }
    this.state = await this.loadPromise;
    return this.state;
  }

  async load() {
    let state = null;
    try {
      state = JSON.parse(await fs.readFile(this.storePath, 'utf8'));
    } catch (_error) {
      state = null;
    }

    const previousVersion = state && typeof state === 'object' ? Number(state.version || 1) : 0;
    const next = {
      version: 2,
      users: {},
      sessions: {},
      email_verification_tokens: {},
      audit: [],
      ...(state && typeof state === 'object' ? state : {})
    };

    next.users = next.users && typeof next.users === 'object' ? next.users : {};
    next.sessions = next.sessions && typeof next.sessions === 'object' ? next.sessions : {};
    next.email_verification_tokens =
      next.email_verification_tokens && typeof next.email_verification_tokens === 'object'
        ? next.email_verification_tokens
        : {};
    next.audit = Array.isArray(next.audit) ? next.audit.slice(-MAX_AUDIT_ITEMS) : [];

    this.ensureSeedUser(next, 'asdleng', process.env.JGZJ_SUPERADMIN_PASSWORD || 'Asd174524', {
      display_name: 'asdleng',
      super_admin: true,
      email: process.env.JGZJ_SUPERADMIN_EMAIL || '',
      permissions: []
    });
    this.ensureSeedUser(next, 'jgauto402', process.env.JGZJ_OPERATOR_PASSWORD || 'jgauto402', {
      display_name: 'jgauto402',
      super_admin: false,
      email: process.env.JGZJ_OPERATOR_EMAIL || '',
      permissions: OPERATOR_ALL_PERMISSIONS
    });

    Object.values(next.users).forEach((user) => {
      this.normalizeStoredUser(user);
      if (previousVersion < 2) {
        user.email_verified = false;
        user.email_verified_at = null;
        user.email_verification_sent_at = null;
      }
    });
    this.cleanupEmailVerificationTokens(next);
    next.version = 2;

    await this.persist(next);
    return next;
  }

  normalizeStoredUser(user) {
    user.email = normalizeEmail(user.email);
    user.email_verified = Boolean(user.email && user.email_verified);
    user.email_verified_at = user.email_verified ? user.email_verified_at || nowIso() : null;
    user.email_verification_sent_at = user.email_verification_sent_at || null;
    user.permissions = sanitizePermissions(user.permissions);
    user.active = user.active !== false;
  }

  ensureSeedUser(state, username, password, options) {
    const normalized = normalizeUsername(username);
    const existing = state.users[normalized];
    if (!existing) {
      state.users[normalized] = createDefaultUser(normalized, password, options);
      return;
    }
    existing.username = normalized;
    existing.display_name = existing.display_name || options.display_name || normalized;
    existing.active = existing.active !== false;
    existing.super_admin = Boolean(options.super_admin);
    if (!existing.email && options.email) {
      existing.email = normalizeEmail(options.email);
    }
    if (options.super_admin) {
      existing.permissions = [];
    } else {
      existing.permissions = sanitizePermissions(existing.permissions);
    }
    existing.updated_at = existing.updated_at || nowIso();
    if (!existing.password_hash) {
      existing.password_hash = hashPassword(password);
    }
    this.normalizeStoredUser(existing);
  }

  cleanupEmailVerificationTokens(state) {
    const now = Date.now();
    Object.entries(state.email_verification_tokens || {}).forEach(([hash, item]) => {
      if (!item || Number(item.expires_at_ms || 0) <= now || item.used_at_ms) {
        delete state.email_verification_tokens[hash];
      }
    });
  }

  async persist(state = this.state) {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    const tmpPath = `${this.storePath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmpPath, this.storePath);
  }

  async withWriteLock(fn) {
    const run = this.writeLock.catch(() => {}).then(async () => {
      const state = await this.ensureLoaded();
      const result = await fn(state);
      await this.persist(state);
      return result;
    });
    this.writeLock = run.catch(() => {});
    return run;
  }

  addAudit(state, actor, action, target, detail = {}) {
    state.audit.push({
      at: nowIso(),
      actor: actor || null,
      action,
      target: target || null,
      detail
    });
    if (state.audit.length > MAX_AUDIT_ITEMS) {
      state.audit.splice(0, state.audit.length - MAX_AUDIT_ITEMS);
    }
  }

  async register(payload = {}, meta = {}) {
    const username = normalizeUsername(payload.username);
    const password = String(payload.password || '');
    const email = normalizeEmail(payload.email);
    const displayName = String(payload.display_name || username).trim().slice(0, 64) || username;
    if (!isValidUsername(username)) {
      const error = new Error('invalid_username');
      error.status = 400;
      throw error;
    }
    if (!isStrongEnoughPassword(password)) {
      const error = new Error('weak_password');
      error.status = 400;
      throw error;
    }
    if (!isValidEmail(email)) {
      const error = new Error('invalid_email');
      error.status = 400;
      throw error;
    }

    return this.withWriteLock((state) => {
      if (state.users[username]) {
        const error = new Error('username_exists');
        error.status = 409;
        throw error;
      }
      const user = createDefaultUser(username, password, {
        display_name: displayName,
        email,
        email_verified: false,
        permissions: REGISTERED_DEFAULT_PERMISSIONS
      });
      state.users[username] = user;
      this.addAudit(state, username, 'auth.register', username, {
        ip: meta.ip || null
      });
      return publicUser(user);
    });
  }

  async updateOwnEmail(usernameRaw, emailRaw, meta = {}) {
    const username = normalizeUsername(usernameRaw);
    const email = normalizeEmail(emailRaw);
    if (!isValidEmail(email)) {
      const error = new Error('invalid_email');
      error.status = 400;
      throw error;
    }
    return this.withWriteLock((state) => {
      const user = state.users[username];
      if (!user || user.active === false) {
        const error = new Error('user_not_found');
        error.status = 404;
        throw error;
      }
      if (user.email !== email) {
        user.email = email;
        user.email_verified = false;
        user.email_verified_at = null;
        user.email_verification_sent_at = null;
      }
      user.updated_at = nowIso();
      this.addAudit(state, username, 'auth.email.update', username, {
        email,
        ip: meta.ip || null
      });
      return publicUser(user);
    });
  }

  async issueEmailVerification(usernameRaw, meta = {}, options = {}) {
    const username = normalizeUsername(usernameRaw);
    return this.withWriteLock((state) => {
      this.cleanupEmailVerificationTokens(state);
      const user = state.users[username];
      if (!user || user.active === false) {
        const error = new Error('user_not_found');
        error.status = 404;
        throw error;
      }
      if (!isValidEmail(user.email)) {
        const error = new Error('email_required');
        error.status = 400;
        throw error;
      }
      const lastSent = Date.parse(user.email_verification_sent_at || '');
      if (!options.force && Number.isFinite(lastSent) && Date.now() - lastSent < this.emailVerificationResendMs) {
        const error = new Error('email_verification_rate_limited');
        error.status = 429;
        error.retry_after_ms = this.emailVerificationResendMs - (Date.now() - lastSent);
        throw error;
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const hashed = tokenHash(token);
      const expiresAt = Date.now() + this.emailVerificationTtlMs;
      state.email_verification_tokens[hashed] = {
        username,
        email: user.email,
        created_at_ms: Date.now(),
        expires_at_ms: expiresAt,
        ip: meta.ip || null,
        user_agent: meta.user_agent || null
      };
      user.email_verification_sent_at = nowIso();
      user.updated_at = nowIso();
      this.addAudit(state, username, 'auth.email.verification.issue', username, {
        email: user.email,
        ip: meta.ip || null
      });
      return {
        token,
        email: user.email,
        expires_at_ms: expiresAt,
        user: publicUser(user)
      };
    });
  }

  async verifyEmailToken(tokenRaw, meta = {}) {
    const token = String(tokenRaw || '').trim();
    if (!token) {
      const error = new Error('invalid_email_token');
      error.status = 400;
      throw error;
    }
    const hashed = tokenHash(token);
    return this.withWriteLock((state) => {
      const item = state.email_verification_tokens[hashed];
      if (!item || Number(item.expires_at_ms || 0) <= Date.now() || item.used_at_ms) {
        delete state.email_verification_tokens[hashed];
        const error = new Error('invalid_or_expired_email_token');
        error.status = 400;
        throw error;
      }
      const user = state.users[normalizeUsername(item.username)];
      if (!user || user.active === false || normalizeEmail(user.email) !== normalizeEmail(item.email)) {
        delete state.email_verification_tokens[hashed];
        const error = new Error('invalid_or_expired_email_token');
        error.status = 400;
        throw error;
      }
      user.email_verified = true;
      user.email_verified_at = nowIso();
      user.updated_at = nowIso();
      delete state.email_verification_tokens[hashed];
      this.addAudit(state, user.username, 'auth.email.verified', user.username, {
        email: user.email,
        ip: meta.ip || null
      });
      return publicUser(user);
    });
  }

  async login(usernameRaw, password, meta = {}) {
    const identifier = String(usernameRaw || '').trim();
    const normalizedUsername = normalizeUsername(identifier);
    const normalizedEmail = normalizeEmail(identifier);
    const state = await this.ensureLoaded();
    let username = normalizedUsername;
    let user = state.users[username];
    if (!user && normalizedEmail && identifier.includes('@')) {
      const emailMatches = Object.values(state.users || {}).filter(
        (item) => normalizeEmail(item?.email) === normalizedEmail
      );
      if (emailMatches.length === 1) {
        user = emailMatches[0];
        username = user.username;
      }
    }
    if (!user || user.active === false || !verifyPassword(password, user.password_hash)) {
      const error = new Error('login_failed');
      error.status = 401;
      throw error;
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const hashed = tokenHash(token);
    const expiresAt = Date.now() + this.sessionTtlMs;
    await this.withWriteLock((lockedState) => {
      const lockedUser = lockedState.users[username];
      if (!lockedUser || lockedUser.active === false || !verifyPassword(password, lockedUser.password_hash)) {
        const error = new Error('login_failed');
        error.status = 401;
        throw error;
      }
      lockedState.sessions[hashed] = {
        username,
        created_at_ms: Date.now(),
        expires_at_ms: expiresAt,
        last_seen_at_ms: Date.now(),
        ip: meta.ip || null,
        user_agent: meta.user_agent || null
      };
      lockedUser.last_login_at = nowIso();
      lockedUser.updated_at = lockedUser.updated_at || nowIso();
      this.addAudit(lockedState, username, 'auth.login', username, {
        ip: meta.ip || null
      });
    });
    return {
      token,
      expires_at_ms: expiresAt,
      user: publicUser(user)
    };
  }

  async getAuthFromRequest(req, options = {}) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[this.cookieName];
    if (!token) {
      return null;
    }
    const hashed = tokenHash(token);
    const state = await this.ensureLoaded();
    const session = state.sessions[hashed];
    if (!session || Number(session.expires_at_ms) <= Date.now()) {
      if (session) {
        await this.withWriteLock((lockedState) => {
          delete lockedState.sessions[hashed];
        });
      }
      return null;
    }
    const user = state.users[session.username];
    if (!user || user.active === false) {
      return null;
    }
    if (options.touch !== false) {
      session.last_seen_at_ms = Date.now();
    }
    return {
      token_hash: hashed,
      session,
      username: user.username,
      user: publicUser(user)
    };
  }

  async logout(req, actor = null) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[this.cookieName];
    if (!token) {
      return;
    }
    const hashed = tokenHash(token);
    await this.withWriteLock((state) => {
      const session = state.sessions[hashed];
      delete state.sessions[hashed];
      this.addAudit(state, actor || session?.username || null, 'auth.logout', session?.username || null);
    });
  }

  setSessionCookie(res, token, maxAgeMs = this.sessionTtlMs) {
    res.append(
      'Set-Cookie',
      serializeCookie(this.cookieName, token, {
        path: '/',
        maxAgeMs,
        httpOnly: true,
        sameSite: 'Lax',
        secure: this.secureCookie
      })
    );
  }

  clearSessionCookie(res) {
    res.append(
      'Set-Cookie',
      serializeCookie(this.cookieName, '', {
        path: '/',
        maxAgeMs: 0,
        httpOnly: true,
        sameSite: 'Lax',
        secure: this.secureCookie
      })
    );
  }

  hasPermission(user, permission) {
    if (!permission) {
      return true;
    }
    if (!user) {
      return false;
    }
    if (!isEmailVerified(user)) {
      return false;
    }
    if (user.super_admin) {
      return true;
    }
    const permissions = new Set(user.effective_permissions || user.permissions || []);
    return permissions.has(permission);
  }

  hasAnyPermission(user, permissions) {
    return (Array.isArray(permissions) ? permissions : [permissions]).some((permission) =>
      this.hasPermission(user, permission)
    );
  }

  async requireLogin(req, res, next) {
    const auth = await this.getAuthFromRequest(req);
    if (!auth) {
      this.clearSessionCookie(res);
      return res.status(401).json({
        ok: false,
        error: 'login_required',
        detail: '请先登录。'
      });
    }
    req.jgzjAuth = auth;
    return next();
  }

  requirePermission(permission) {
    return async (req, res, next) => {
      const auth = await this.getAuthFromRequest(req);
      if (!auth) {
        this.clearSessionCookie(res);
        return res.status(401).json({
          ok: false,
          error: 'login_required',
          required_permission: permission,
          detail: '请先登录。'
        });
      }
      if (!this.hasPermission(auth.user, permission)) {
        return res.status(403).json({
          ok: false,
          error: auth.user.email_verified ? 'permission_denied' : 'email_verification_required',
          required_permission: permission,
          detail: auth.user.email_verified
            ? '当前账号没有执行此操作的权限。'
            : '请先完成邮箱验证，未验证账号暂不具备任何权限。'
        });
      }
      req.jgzjAuth = auth;
      return next();
    };
  }

  requireAnyPermission(permissions) {
    const list = Array.isArray(permissions) ? permissions : [permissions];
    return async (req, res, next) => {
      const auth = await this.getAuthFromRequest(req);
      if (!auth) {
        this.clearSessionCookie(res);
        return res.status(401).json({
          ok: false,
          error: 'login_required',
          required_permissions: list,
          detail: '请先登录。'
        });
      }
      if (!this.hasAnyPermission(auth.user, list)) {
        return res.status(403).json({
          ok: false,
          error: auth.user.email_verified ? 'permission_denied' : 'email_verification_required',
          required_permissions: list,
          detail: auth.user.email_verified
            ? '当前账号没有执行此操作的权限。'
            : '请先完成邮箱验证，未验证账号暂不具备任何权限。'
        });
      }
      req.jgzjAuth = auth;
      return next();
    };
  }

  async requireSuperAdmin(req, res, next) {
    const auth = await this.getAuthFromRequest(req);
    if (!auth) {
      this.clearSessionCookie(res);
      return res.status(401).json({
        ok: false,
        error: 'login_required',
        detail: '请先登录。'
      });
    }
    if (!auth.user.super_admin) {
      return res.status(403).json({
        ok: false,
        error: auth.user.email_verified ? 'super_admin_required' : 'email_verification_required',
        detail: auth.user.email_verified
          ? '只有超级管理员可以管理账号权限。'
          : '请先完成邮箱验证，未验证账号暂不具备任何权限。'
      });
    }
    if (!this.hasPermission(auth.user, 'admin:all')) {
      return res.status(403).json({
        ok: false,
        error: 'email_verification_required',
        detail: '请先完成邮箱验证，未验证账号暂不具备任何权限。'
      });
    }
    req.jgzjAuth = auth;
    return next();
  }

  async ensureRequestPermission(req, res, permission) {
    const auth = await this.getAuthFromRequest(req);
    if (!auth) {
      this.clearSessionCookie(res);
      res.status(401).json({
        ok: false,
        error: 'login_required',
        required_permission: permission,
        detail: '请先登录。'
      });
      return null;
    }
    if (!this.hasPermission(auth.user, permission)) {
      res.status(403).json({
        ok: false,
        error: auth.user.email_verified ? 'permission_denied' : 'email_verification_required',
        required_permission: permission,
        detail: auth.user.email_verified
          ? '当前账号没有执行此操作的权限。'
          : '请先完成邮箱验证，未验证账号暂不具备任何权限。'
      });
      return null;
    }
    req.jgzjAuth = auth;
    return auth;
  }

  async listUsers() {
    const state = await this.ensureLoaded();
    return Object.values(state.users)
      .map(publicUser)
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async listAudit() {
    const state = await this.ensureLoaded();
    return (Array.isArray(state.audit) ? state.audit : []).map((item) => ({
      at: item?.at || null,
      actor: item?.actor || null,
      action: item?.action || '',
      target: item?.target || null,
      detail: item?.detail && typeof item.detail === 'object' ? { ...item.detail } : {}
    }));
  }

  async updateUser(actor, usernameRaw, patch = {}) {
    const actorName = normalizeUsername(actor?.username || actor);
    const username = normalizeUsername(usernameRaw);
    return this.withWriteLock((state) => {
      const user = state.users[username];
      if (!user) {
        const error = new Error('user_not_found');
        error.status = 404;
        throw error;
      }
      if (user.super_admin && username !== actorName) {
        const error = new Error('cannot_modify_super_admin');
        error.status = 403;
        throw error;
      }
      if (username === actorName && patch.active === false) {
        const error = new Error('cannot_disable_self');
        error.status = 400;
        throw error;
      }

      if (Array.isArray(patch.permissions) && !user.super_admin) {
        user.permissions = sanitizePermissions(patch.permissions);
      }
      if (typeof patch.active === 'boolean') {
        user.active = patch.active;
      }
      if (typeof patch.display_name === 'string') {
        const nextName = patch.display_name.trim().slice(0, 64);
        user.display_name = nextName || user.username;
      }
      user.updated_at = nowIso();
      this.addAudit(state, actorName, 'auth.user.update', username, {
        permissions: user.permissions,
        active: user.active
      });
      return publicUser(user);
    });
  }

  permissions() {
    return PERMISSIONS;
  }
}

function createAuthStore(options = {}) {
  return new AuthStore(options);
}

module.exports = {
  ALL_PERMISSION_IDS,
  OPERATOR_ALL_PERMISSIONS,
  PERMISSIONS,
  REGISTERED_DEFAULT_PERMISSIONS,
  createAuthStore
};
