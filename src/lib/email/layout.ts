/**
 * E-Mail-Grundlayout.
 *
 * Architekturentscheid: Tabellenbasiertes HTML mit Inline-Styles — Outlook und
 * Gmail unterstützen weder Flexbox/Grid noch externe Stylesheets zuverlässig.
 * Die Palette spiegelt das Web-Branding, damit E-Mails als Teil des Produkts
 * wahrgenommen werden. Dark-Mode-Hinweise via `color-scheme`.
 */

export interface EmailBrand {
  companyName: string;
  logoUrl?: string | null;
  primaryColor: string;
  appUrl: string;
  address: string;
  phone: string;
  email: string;
  vatNumber?: string | null;
}

export const defaultBrand: EmailBrand = {
  companyName: process.env.COMPANY_NAME ?? 'Clenaris Reinigungen GmbH',
  logoUrl: null,
  primaryColor: '#0B7285',
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'https://clenaris.ch',
  address: `${process.env.COMPANY_STREET ?? 'Bahnhofstrasse 1'}, ${process.env.COMPANY_ZIP ?? '3011'} ${process.env.COMPANY_CITY ?? 'Bern'}`,
  phone: process.env.COMPANY_PHONE ?? '+41 31 000 00 00',
  email: process.env.COMPANY_EMAIL ?? 'info@clenaris.ch',
  vatNumber: process.env.COMPANY_VAT_NUMBER ?? null,
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function button(label: string, url: string, brand = defaultBrand): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
    <tr>
      <td align="center" bgcolor="${brand.primaryColor}" style="border-radius:12px;">
        <a href="${url}" target="_blank"
           style="display:inline-block;padding:14px 30px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;letter-spacing:-0.01em;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>
  </table>`;
}

export function infoTable(rows: { label: string; value: string }[]): string {
  const cells = rows
    .map(
      (row, index) => `
      <tr>
        <td style="padding:12px 0;${index > 0 ? 'border-top:1px solid #E8EDF2;' : ''}font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#64748B;width:42%;vertical-align:top;">
          ${escapeHtml(row.label)}
        </td>
        <td style="padding:12px 0;${index > 0 ? 'border-top:1px solid #E8EDF2;' : ''}font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#0F172A;font-weight:600;text-align:right;vertical-align:top;">
          ${row.value}
        </td>
      </tr>`,
    )
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;background:#F8FAFC;border-radius:14px;padding:8px 20px;">${cells}</table>`;
}

export function callout(text: string, tone: 'info' | 'warning' | 'success' = 'info'): string {
  const palette = {
    info: { bg: '#EFF6FF', border: '#BFDBFE', color: '#1E40AF' },
    warning: { bg: '#FFF7ED', border: '#FED7AA', color: '#9A3412' },
    success: { bg: '#F0FDF4', border: '#BBF7D0', color: '#166534' },
  }[tone];

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;">
    <tr>
      <td style="background:${palette.bg};border:1px solid ${palette.border};border-radius:12px;padding:14px 18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:${palette.color};">
        ${text}
      </td>
    </tr>
  </table>`;
}

export interface LayoutOptions {
  preheader?: string;
  brand?: EmailBrand;
  /** Abmeldelink für Marketing-Mails (rechtlich erforderlich). */
  unsubscribeUrl?: string;
}

export function renderEmail(
  title: string,
  bodyHtml: string,
  options: LayoutOptions = {},
): string {
  const brand = options.brand ?? defaultBrand;
  const preheader = options.preheader ?? '';

  return `<!DOCTYPE html>
<html lang="de" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#F1F5F9;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF;border-radius:20px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.06),0 12px 32px -12px rgba(15,23,42,0.12);">

          <!-- Kopfzeile -->
          <tr>
            <td style="padding:32px 40px 8px 40px;">
              ${
                brand.logoUrl
                  ? `<img src="${brand.logoUrl}" alt="${escapeHtml(brand.companyName)}" width="150" style="display:block;border:0;max-width:150px;height:auto;">`
                  : `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:21px;font-weight:700;color:${brand.primaryColor};letter-spacing:-0.03em;">${escapeHtml(brand.companyName)}</div>`
              }
            </td>
          </tr>

          <!-- Inhalt -->
          <tr>
            <td style="padding:16px 40px 36px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#334155;">
              <h1 style="margin:0 0 18px 0;font-size:24px;line-height:1.25;font-weight:700;color:#0F172A;letter-spacing:-0.03em;">${escapeHtml(title)}</h1>
              ${bodyHtml}
            </td>
          </tr>

          <!-- Fusszeile -->
          <tr>
            <td style="padding:26px 40px 32px 40px;background:#F8FAFC;border-top:1px solid #E8EDF2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12.5px;line-height:1.7;color:#64748B;">
              <strong style="color:#0F172A;">${escapeHtml(brand.companyName)}</strong><br>
              ${escapeHtml(brand.address)}<br>
              <a href="tel:${brand.phone.replace(/\s/g, '')}" style="color:${brand.primaryColor};text-decoration:none;">${escapeHtml(brand.phone)}</a> ·
              <a href="mailto:${brand.email}" style="color:${brand.primaryColor};text-decoration:none;">${escapeHtml(brand.email)}</a>
              ${brand.vatNumber ? `<br>${escapeHtml(brand.vatNumber)}` : ''}
              <div style="margin-top:14px;">
                <a href="${brand.appUrl}/legal/datenschutz" style="color:#64748B;text-decoration:underline;">Datenschutz</a> ·
                <a href="${brand.appUrl}/legal/impressum" style="color:#64748B;text-decoration:underline;">Impressum</a>
                ${
                  options.unsubscribeUrl
                    ? ` · <a href="${options.unsubscribeUrl}" style="color:#64748B;text-decoration:underline;">Abmelden</a>`
                    : ''
                }
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
