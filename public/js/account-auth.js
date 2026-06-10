(() => {
  const componentMode = document.currentScript?.dataset.authMode || "controller";
  const endpoints = {
    me: "/api/auth/me",
    login: "/api/auth/login",
    logout: "/api/auth/logout",
    register: "/api/auth/register",
    verifyEmail: "/api/auth/request-email-verification",
    users: "/api/auth/users",
    permissions: "/api/auth/permissions",
    privateNavigation: "/api/site/private-navigation"
  };

  const current = document.getElementById("jgzj-auth-current");
  const guestPane = document.getElementById("jgzj-auth-guest");
  const userPane = document.getElementById("jgzj-auth-user");
  const adminPane = document.getElementById("jgzj-auth-admin");
  const statusNode = document.getElementById("jgzj-auth-status");
  const permissionsNode = document.getElementById("jgzj-auth-permissions");
  const loginForm = document.getElementById("jgzj-login-form");
  const registerForm = document.getElementById("jgzj-register-form");
  const emailForm = document.getElementById("jgzj-email-form");
  const emailInput = document.getElementById("jgzj-email-input");
  const emailState = document.getElementById("jgzj-email-state");
  const emailSend = document.getElementById("jgzj-email-send");
  const logoutBtn = document.getElementById("jgzj-logout");
  const adminRefreshBtn = document.getElementById("jgzj-admin-refresh");
  const adminUserList = document.getElementById("jgzj-admin-user-list");
  const adminForm = document.getElementById("jgzj-admin-form");
  const adminSelected = document.getElementById("jgzj-admin-selected");
  const adminActive = document.getElementById("jgzj-admin-active");
  const adminPermissionList = document.getElementById("jgzj-admin-permission-list");
  const adminSave = document.getElementById("jgzj-admin-save");

  let authState = { authenticated: false, user: null, permissions: [] };
  let allPermissions = [];
  let adminUsers = [];
  let selectedUsername = "";
  let privateNavItems = [];

  function setStatus(text, state = "idle") {
    if (!statusNode) return;
    statusNode.textContent = text;
    statusNode.dataset.state = state;
  }

  function hasPermission(permission) {
    if (!permission) return true;
    if (!authState.user?.email_verified) return false;
    if (authState.user?.super_admin) return true;
    return (authState.permissions || []).includes(permission);
  }

  function dispatchAuthChange() {
    window.dispatchEvent(new CustomEvent("jgzj:auth-change", { detail: authState }));
  }

  function canAccessPrivateItem(item) {
    const user = authState.user;
    if (!user?.email_verified) return false;
    if (user.super_admin) return true;
    const required = Array.isArray(item.permissions) ? item.permissions : [];
    if (!required.length) return Boolean(user);
    return required.some((permission) => (authState.permissions || []).includes(permission));
  }

  function setActiveLink(link, href) {
    const currentPath = window.location.pathname.replace(/\/$/, "") || "/";
    const itemPath = String(href || "").replace(/\/$/, "") || "/";
    link.classList.toggle("is-active", currentPath === itemPath);
  }

  async function loadPrivateNavigation() {
    if (!authState.user?.email_verified) {
      privateNavItems = [];
      return;
    }
    try {
      const data = await requestJson(endpoints.privateNavigation);
      privateNavItems = Array.isArray(data.items) ? data.items : [];
    } catch (_error) {
      privateNavItems = [];
    }
  }

  function renderPrivateNavigation() {
    const items = privateNavItems.filter(canAccessPrivateItem);
    document.querySelectorAll("[data-private-nav]").forEach((container) => {
      container.innerHTML = "";
      items.forEach((item) => {
        const link = document.createElement("a");
        link.href = item.href;
        link.textContent = item.label;
        setActiveLink(link, item.href);
        container.appendChild(link);
      });
      container.hidden = items.length === 0;
    });

    document.querySelectorAll("[data-private-workspace-list]").forEach((container) => {
      container.innerHTML = "";
      if (!authState.user) {
        container.hidden = true;
        return;
      }

      const title = document.createElement("p");
      title.className = "site-auth-muted";
      title.textContent = items.length ? "当前账号可访问" : "当前账号暂无可访问的内部页面。";
      container.appendChild(title);

      if (items.length) {
        const list = document.createElement("div");
        list.className = "site-auth-workspace-grid";
        items.forEach((item) => {
          const link = document.createElement("a");
          link.href = item.href;
          link.textContent = item.label;
          list.appendChild(link);
        });
        container.appendChild(list);
      }
      container.hidden = false;
    });

    document.querySelectorAll('a[href="/login"]').forEach((link) => {
      link.textContent = authState.user ? "账号中心" : "登录";
    });
  }

  function safeNextPath() {
    const next = new URLSearchParams(window.location.search).get("next");
    if (!next) return "";
    try {
      const parsed = new URL(next, window.location.origin);
      if (parsed.origin !== window.location.origin) return "";
      if (!parsed.pathname.startsWith("/") || parsed.pathname === "/login") return "";
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch (_error) {
      return "";
    }
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
    }
    return data;
  }

  function groupedPermissions() {
    const groups = new Map();
    allPermissions.forEach((permission) => {
      const group = permission.group || "其他";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(permission);
    });
    return [...groups.entries()];
  }

  function renderOwnPermissions() {
    if (!permissionsNode) return;
    permissionsNode.innerHTML = "";
    const title = document.createElement("p");
    title.className = "site-auth-muted";
    title.textContent = !authState.user?.email_verified
      ? "邮箱未验证，当前账号暂无有效权限。"
      : authState.user?.super_admin
        ? "当前账号是超级管理员，拥有全部权限。"
        : "当前账号权限";
    permissionsNode.appendChild(title);

    const effective = new Set(authState.permissions || []);
    const list = document.createElement("div");
    list.className = "site-auth-permission-chips";
    allPermissions.forEach((permission) => {
      if (!authState.user?.email_verified) return;
      if (!authState.user?.super_admin && !effective.has(permission.id)) return;
      const chip = document.createElement("span");
      chip.textContent = permission.label;
      list.appendChild(chip);
    });
    if (!list.childElementCount) {
      const empty = document.createElement("p");
      empty.className = "site-auth-muted";
      empty.textContent = authState.user?.email_verified
        ? "暂无互动权限，请联系超级管理员分配。"
        : "请先完成邮箱验证。";
      permissionsNode.appendChild(empty);
      return;
    }
    permissionsNode.appendChild(list);
  }

  function renderAuthState() {
    const user = authState.user;
    if (current) {
      current.textContent = user
        ? `已登录：${user.username}${user.super_admin ? "（超级管理员）" : ""}${user.email_verified ? "" : "（邮箱未验证）"}`
        : "未登录。注册后必须完成邮箱验证，互动能力再由超级管理员分配。";
    }
    if (guestPane) guestPane.hidden = Boolean(user);
    if (userPane) userPane.hidden = !user;
    if (adminPane) adminPane.hidden = !user?.super_admin || !user?.email_verified;
    renderEmailState();
    renderOwnPermissions();
    renderPrivateNavigation();
    applyPermissionLocks();
  }

  function renderEmailState() {
    const user = authState.user;
    if (!emailForm || !emailInput || !emailState || !emailSend) return;
    emailInput.value = user?.email || "";
    emailInput.disabled = !user;
    emailSend.disabled = !user;
    if (!user) {
      emailState.textContent = "登录后可验证邮箱。";
      emailState.dataset.state = "idle";
      return;
    }
    if (user.email_verified) {
      emailState.textContent = `已验证：${user.email}`;
      emailState.dataset.state = "ok";
      emailSend.textContent = "更换邮箱并验证";
      return;
    }
    emailState.textContent = user.email
      ? `未验证：${user.email}。未验证账号暂不具备任何权限。`
      : "未填写邮箱。未验证账号暂不具备任何权限。";
    emailState.dataset.state = "error";
    emailSend.textContent = "发送验证邮件";
  }

  function applyPermissionLocks() {
    document.querySelectorAll("[data-requires-permission]").forEach((panel) => {
      const permission = panel.getAttribute("data-requires-permission") || "";
      const allowed = hasPermission(permission);
      panel.dataset.permissionState = allowed ? "allowed" : "locked";
      panel.querySelectorAll("button, input, select, textarea").forEach((control) => {
        if (control.closest(".site-auth-dialog")) return;
        if (!allowed) {
          if (!control.disabled) {
            control.dataset.authLockDisabled = "true";
          }
          control.disabled = true;
        } else if (control.dataset.authLockDisabled === "true") {
          control.disabled = false;
          delete control.dataset.authLockDisabled;
        }
      });
      let note = panel.querySelector(":scope > .auth-lock-message");
      if (!allowed) {
        if (!note) {
          note = document.createElement("p");
          note.className = "auth-lock-message";
          panel.prepend(note);
        }
        const label = allPermissions.find((item) => item.id === permission)?.label || permission;
        note.textContent = authState.user
          ? authState.user.email_verified
            ? `当前账号缺少权限：${label}`
            : `邮箱验证后可申请使用：${label}`
          : `登录后可使用：${label}`;
      } else if (note) {
        note.remove();
      }
    });
  }

  async function refreshMe(options = {}) {
    try {
      const [me, permissionPayload] = await Promise.all([
        requestJson(endpoints.me),
        allPermissions.length ? Promise.resolve({ permissions: allPermissions }) : requestJson(endpoints.permissions)
      ]);
      allPermissions = Array.isArray(permissionPayload.permissions) ? permissionPayload.permissions : [];
      authState = {
        authenticated: Boolean(me.authenticated),
        user: me.user || null,
        permissions: Array.isArray(me.permissions) ? me.permissions : []
      };
      await loadPrivateNavigation();
      renderAuthState();
      if (options.dispatch !== false) {
        dispatchAuthChange();
      }
      if (authState.user?.super_admin && authState.user?.email_verified && !adminUsers.length) {
        loadAdminUsers().catch(() => {});
      }
    } catch (_error) {
      authState = { authenticated: false, user: null, permissions: [] };
      privateNavItems = [];
      renderAuthState();
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    const username = document.getElementById("jgzj-login-username")?.value.trim() || "";
    const password = document.getElementById("jgzj-login-password")?.value || "";
    if (!username || !password) {
      setStatus("请输入用户名和密码。", "error");
      return;
    }
    setStatus("登录中...", "loading");
    try {
      await requestJson(endpoints.login, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      document.getElementById("jgzj-login-password").value = "";
      await refreshMe();
      setStatus("登录成功。", "ok");
      const next = safeNextPath();
      if (componentMode === "page" && next) {
        window.location.assign(next);
      }
    } catch (error) {
      setStatus(error?.message || "登录失败。", "error");
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    const username = document.getElementById("jgzj-register-username")?.value.trim() || "";
    const email = document.getElementById("jgzj-register-email")?.value.trim() || "";
    const password = document.getElementById("jgzj-register-password")?.value || "";
    if (!username || !email || !password) {
      setStatus("请输入用户名、邮箱和密码。", "error");
      return;
    }
    setStatus("注册中...", "loading");
    try {
      await requestJson(endpoints.register, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password })
      });
      document.getElementById("jgzj-register-password").value = "";
      await refreshMe();
      setStatus("注册成功，已发送邮箱验证。验证完成前账号暂无有效权限。", "ok");
    } catch (error) {
      setStatus(error?.message || "注册失败。", "error");
    }
  }

  async function handleEmailVerification(event) {
    event.preventDefault();
    if (!authState.user) return;
    const email = emailInput?.value.trim() || "";
    if (!email) {
      setStatus("请输入邮箱。", "error");
      return;
    }
    if (emailSend) emailSend.disabled = true;
    setStatus("正在发送验证邮件...", "loading");
    try {
      const data = await requestJson(endpoints.verifyEmail, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      await refreshMe();
      const mode = data.email_delivery?.mode;
      setStatus(
        mode === "outbox"
          ? "SMTP 未配置，验证链接已写入服务器 outbox。"
          : "验证邮件已发送，请打开邮箱完成验证。",
        "ok"
      );
    } catch (error) {
      setStatus(error?.message || "验证邮件发送失败。", "error");
    } finally {
      if (emailSend) emailSend.disabled = false;
    }
  }

  async function handleLogout() {
    setStatus("正在退出...", "loading");
    await requestJson(endpoints.logout, { method: "POST" }).catch(() => {});
    authState = { authenticated: false, user: null, permissions: [] };
    privateNavItems = [];
    adminUsers = [];
    selectedUsername = "";
    renderAuthState();
    dispatchAuthChange();
    setStatus("已退出登录。", "idle");
  }

  function renderAdminUsers() {
    if (!adminUserList) return;
    adminUserList.innerHTML = "";
    adminUsers.forEach((user) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "site-auth-user-row";
      button.dataset.active = user.active ? "true" : "false";
      button.dataset.selected = user.username === selectedUsername ? "true" : "false";
      button.textContent = `${user.username}${user.super_admin ? " · 超级管理员" : ""}${user.email_verified ? "" : " · 邮箱未验证"}`;
      button.addEventListener("click", () => selectAdminUser(user.username));
      adminUserList.appendChild(button);
    });
  }

  function selectAdminUser(username) {
    selectedUsername = username;
    const user = adminUsers.find((item) => item.username === username);
    renderAdminUsers();
    if (!user || !adminPermissionList || !adminSelected || !adminActive || !adminSave) return;
    adminSelected.textContent = `正在编辑：${user.username}${user.super_admin ? "（超级管理员不可修改权限）" : ""}`;
    adminActive.checked = user.active !== false;
    adminActive.disabled = Boolean(user.super_admin);
    adminPermissionList.innerHTML = "";
    const granted = new Set(user.permissions || []);
    groupedPermissions().forEach(([group, permissions]) => {
      const groupNode = document.createElement("fieldset");
      groupNode.className = "site-auth-permission-group";
      const legend = document.createElement("legend");
      legend.textContent = group;
      groupNode.appendChild(legend);
      permissions.forEach((permission) => {
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = permission.id;
        checkbox.checked = user.super_admin || granted.has(permission.id);
        checkbox.disabled = Boolean(user.super_admin);
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(permission.label));
        groupNode.appendChild(label);
      });
      adminPermissionList.appendChild(groupNode);
    });
    adminSave.disabled = Boolean(user.super_admin);
  }

  async function loadAdminUsers() {
    if (!authState.user?.super_admin || !authState.user?.email_verified) return;
    const data = await requestJson(endpoints.users);
    adminUsers = Array.isArray(data.users) ? data.users : [];
    allPermissions = Array.isArray(data.permissions) ? data.permissions : allPermissions;
    if (!selectedUsername && adminUsers.length) selectedUsername = adminUsers[0].username;
    renderAdminUsers();
    if (selectedUsername) selectAdminUser(selectedUsername);
  }

  async function saveAdminUser(event) {
    event.preventDefault();
    const user = adminUsers.find((item) => item.username === selectedUsername);
    if (!user || user.super_admin) return;
    const permissions = [...adminPermissionList.querySelectorAll("input[type='checkbox']:checked")].map((input) => input.value);
    setStatus("正在保存权限...", "loading");
    try {
      const data = await requestJson(`${endpoints.users}/${encodeURIComponent(user.username)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          active: Boolean(adminActive.checked),
          permissions
        })
      });
      adminUsers = adminUsers.map((item) => (item.username === data.user.username ? data.user : item));
      renderAdminUsers();
      selectAdminUser(data.user.username);
      setStatus("权限已保存。", "ok");
    } catch (error) {
      setStatus(error?.message || "保存失败。", "error");
    }
  }

  loginForm?.addEventListener("submit", handleLogin);
  registerForm?.addEventListener("submit", handleRegister);
  emailForm?.addEventListener("submit", handleEmailVerification);
  logoutBtn?.addEventListener("click", handleLogout);
  adminRefreshBtn?.addEventListener("click", () => loadAdminUsers().catch((error) => setStatus(error?.message || "加载失败。", "error")));
  adminForm?.addEventListener("submit", saveAdminUser);
  window.addEventListener("jgzj:permissions-refresh", () => refreshMe());

  function bootAuthUi() {
    refreshMe({ dispatch: false }).then(() => {
      applyPermissionLocks();
      dispatchAuthChange();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootAuthUi, { once: true });
  } else {
    bootAuthUi();
  }
})();
