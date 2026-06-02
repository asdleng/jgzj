const fs = require('fs/promises');
const path = require('path');
const nodemailer = require('nodemailer');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function boolEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function createMailer(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const outboxPath = path.resolve(
    process.env.JGZJ_EMAIL_OUTBOX_PATH || path.join(rootDir, '.runtime/email-outbox.log')
  );
  const smtpHost = String(process.env.SMTP_HOST || '').trim();
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtpSecure = boolEnv(process.env.SMTP_SECURE);
  const smtpUser = String(process.env.SMTP_USER || '').trim();
  const smtpPass = String(process.env.SMTP_PASS || '');
  const from = String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  const configured = Boolean(smtpHost && from);

  let transporter = null;
  function getTransporter() {
    if (!configured) {
      return null;
    }
    if (!transporter) {
      transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: smtpUser || smtpPass ? { user: smtpUser, pass: smtpPass } : undefined
      });
    }
    return transporter;
  }

  async function appendOutbox(entry) {
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });
    await fs.appendFile(outboxPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async function sendVerificationEmail({ to, username, verificationUrl, expiresAtMs }) {
    const subject = '吉光智界账号邮箱验证';
    const expiresText = new Date(Number(expiresAtMs || Date.now())).toLocaleString('zh-CN', {
      hour12: false
    });
    const text = [
      `${username}，你好：`,
      '',
      '请打开下面的链接完成吉光智界账号邮箱验证：',
      verificationUrl,
      '',
      `链接有效期至：${expiresText}`,
      '如果不是你本人操作，可以忽略这封邮件。'
    ].join('\n');
    const html = `
      <div style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0f172a">
        <p>${escapeHtml(username)}，你好：</p>
        <p>请点击下面的链接完成吉光智界账号邮箱验证。</p>
        <p><a href="${escapeHtml(verificationUrl)}" style="color:#0369a1;font-weight:700">验证邮箱</a></p>
        <p>链接有效期至：${escapeHtml(expiresText)}</p>
        <p style="color:#64748b">如果不是你本人操作，可以忽略这封邮件。</p>
      </div>
    `;

    const transport = getTransporter();
    if (transport) {
      const info = await transport.sendMail({ from, to, subject, text, html });
      return {
        ok: true,
        mode: 'smtp',
        message_id: info.messageId || null
      };
    }

    const entry = {
      at: new Date().toISOString(),
      type: 'email_verification',
      to,
      username,
      verification_url: verificationUrl,
      expires_at_ms: expiresAtMs
    };
    await appendOutbox(entry);
    console.warn(`[jgzj-email] SMTP not configured; verification link for ${username} <${to}>: ${verificationUrl}`);
    return {
      ok: true,
      mode: 'outbox',
      outbox_path: outboxPath
    };
  }

  return {
    configured,
    outboxPath,
    sendVerificationEmail
  };
}

module.exports = {
  createMailer
};
