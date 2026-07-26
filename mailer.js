'use strict';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

class KadastroMailer {
  constructor({ apiKey = '', from = '', replyTo = '', appBaseUrl = '' } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.from = String(from || '').trim();
    this.replyTo = String(replyTo || '').trim();
    this.appBaseUrl = String(appBaseUrl || '').trim().replace(/\/$/, '');
  }

  get enabled() {
    return Boolean(this.apiKey && this.from && this.appBaseUrl);
  }

  async send({ to, subject, html, text }) {
    if (!this.enabled) throw new Error('Resend e-posta ayarları tamamlanmadı.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: this.from,
          to: [String(to || '').trim()],
          subject: String(subject || '').trim(),
          html: String(html || ''),
          text: String(text || ''),
          ...(this.replyTo ? { reply_to: this.replyTo } : {})
        }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload?.message || `Resend HTTP ${response.status}`);
        error.httpStatus = 502;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Resend e-posta isteği zaman aşımına uğradı.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async sendInvite({ to, fullName, username, token, expiresAt }) {
    const link = `${this.appBaseUrl}/davet?token=${encodeURIComponent(token)}`;
    const safeName = escapeHtml(fullName || username || 'Kullanıcı');
    const safeUsername = escapeHtml(username);
    const safeLink = escapeHtml(link);
    const expiry = new Date(expiresAt).toLocaleString('tr-TR');
    return this.send({
      to,
      subject: 'Kadastro360 hesabınızı etkinleştirin',
      text: `Merhaba ${fullName || username},\n\nKadastro360 kullanıcı adınız: ${username}\nHesabınızı etkinleştirip parolanızı belirlemek için: ${link}\nBağlantının geçerlilik süresi: ${expiry}\n\nKadastro360`,
      html: `<!doctype html><html lang="tr"><body style="margin:0;background:#eef3f6;font-family:Arial,sans-serif;color:#16222d"><div style="max-width:620px;margin:0 auto;padding:28px 16px"><div style="background:#fff;border:1px solid #d8e0e7;border-radius:18px;padding:26px"><h1 style="font-size:25px;margin:0 0 14px;color:#0e6b51">Kadastro360 daveti</h1><p>Merhaba <strong>${safeName}</strong>,</p><p>Kadastro360 erişim talebiniz onaylandı. Kullanıcı adınız:</p><p style="font-size:18px;font-weight:800;background:#f3f7f5;padding:12px;border-radius:10px">${safeUsername}</p><p>Aşağıdaki düğmeden hesabınızı etkinleştirip güvenli parolanızı belirleyebilirsiniz.</p><p style="margin:24px 0"><a href="${safeLink}" style="display:inline-block;background:#0e6b51;color:#fff;text-decoration:none;font-weight:800;padding:13px 18px;border-radius:10px">Hesabımı etkinleştir</a></p><p style="font-size:12px;color:#5d6c76">Bağlantı ${escapeHtml(expiry)} tarihine kadar geçerlidir. Düğme açılmazsa şu adresi tarayıcınıza yapıştırın:<br>${safeLink}</p></div></div></body></html>`
    });
  }

  async sendPasswordReset({ to, fullName, username, token, expiresAt }) {
    const link = `${this.appBaseUrl}/parola-yenile?token=${encodeURIComponent(token)}`;
    const safeName = escapeHtml(fullName || username || 'Kullanıcı');
    const safeLink = escapeHtml(link);
    const expiry = new Date(expiresAt).toLocaleString('tr-TR');
    return this.send({
      to,
      subject: 'Kadastro360 parola yenileme bağlantısı',
      text: `Merhaba ${fullName || username},\n\nKadastro360 parolanızı yenilemek için: ${link}\nBağlantının geçerlilik süresi: ${expiry}\n\nBu işlemi siz istemediyseniz mesajı yok sayabilirsiniz.`,
      html: `<!doctype html><html lang="tr"><body style="margin:0;background:#eef3f6;font-family:Arial,sans-serif;color:#16222d"><div style="max-width:620px;margin:0 auto;padding:28px 16px"><div style="background:#fff;border:1px solid #d8e0e7;border-radius:18px;padding:26px"><h1 style="font-size:25px;margin:0 0 14px;color:#0e6b51">Parola yenileme</h1><p>Merhaba <strong>${safeName}</strong>,</p><p>Kadastro360 parolanızı yenilemek için aşağıdaki düğmeyi kullanın.</p><p style="margin:24px 0"><a href="${safeLink}" style="display:inline-block;background:#315fae;color:#fff;text-decoration:none;font-weight:800;padding:13px 18px;border-radius:10px">Yeni parola belirle</a></p><p style="font-size:12px;color:#5d6c76">Bağlantı ${escapeHtml(expiry)} tarihine kadar geçerlidir. Bu işlemi siz istemediyseniz mesajı yok sayabilirsiniz.<br>${safeLink}</p></div></div></body></html>`
    });
  }
}

module.exports = { KadastroMailer };
