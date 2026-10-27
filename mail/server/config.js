export const yes = (v) => /^(1|true|yes|on)$/i.test(v || '');

/** Known providers, so most people only need an address and an app password. */
const PROVIDERS = {
  gmail: { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
  yandex: { imap: 'imap.yandex.ru', smtp: 'smtp.yandex.ru' },
  mailru: { imap: 'imap.mail.ru', smtp: 'smtp.mail.ru' },
  icloud: { imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com', smtpPort: 587 },
  outlook: { imap: 'outlook.office365.com', smtp: 'smtp.office365.com', smtpPort: 587 },
  fastmail: { imap: 'imap.fastmail.com', smtp: 'smtp.fastmail.com' },
};

export function accountFromEnv(env = process.env) {
  const preset = PROVIDERS[(env.MAIL_PROVIDER || '').toLowerCase()] || {};
  const user = env.IMAP_USER || env.MAIL_USER;
  const pass = env.IMAP_PASS || env.MAIL_PASS;
  const imapHost = env.IMAP_HOST || preset.imap;
  if (yes(env.MAIL_DEMO) || !imapHost || !user || !pass) return null;

  const imapPort = Number(env.IMAP_PORT || 993);
  const smtpPort = Number(env.SMTP_PORT || preset.smtpPort || 465);
  return {
    imap: {
      host: imapHost,
      port: imapPort,
      secure: env.IMAP_SECURE ? yes(env.IMAP_SECURE) : imapPort === 993,
      auth: { user, pass },
    },
    smtp: {
      host: env.SMTP_HOST || preset.smtp || imapHost.replace(/^imap\./, 'smtp.'),
      port: smtpPort,
      secure: env.SMTP_SECURE ? yes(env.SMTP_SECURE) : smtpPort === 465,
      auth: { user: env.SMTP_USER || user, pass: env.SMTP_PASS || pass },
    },
    from: { name: env.MAIL_FROM_NAME || '', address: env.MAIL_FROM || user },
  };
}

