import { env } from '../../config/env.js';
import { hmac, safeEqual } from '../../lib/crypto.js';

/**
 * Signed, expiring public links to invoice PDFs, so parents (who have no login) can open an
 * invoice shared over WhatsApp. The signature binds the invoice id and expiry.
 */
export function signInvoiceLink(
  invoiceId: string,
  now = Date.now(),
): { url: string; expiresAt: Date } {
  const exp = Math.floor(now / 1000) + env.SHARE_LINK_TTL_DAYS * 86_400;
  const sig = hmac(env.SHARE_LINK_SECRET, `invoice:${invoiceId}:${exp}`);
  return {
    // The app's page asks for the student's registration number before showing the PDF.
    url: `${env.APP_URL}/share/invoice/${invoiceId}?e=${exp}&s=${sig}`,
    expiresAt: new Date(exp * 1000),
  };
}

export function verifyInvoiceLink(
  invoiceId: string,
  exp: string,
  sig: string,
  now = Date.now(),
): boolean {
  const expNum = Number(exp);
  if (!Number.isInteger(expNum) || expNum * 1000 < now) return false;
  return safeEqual(hmac(env.SHARE_LINK_SECRET, `invoice:${invoiceId}:${expNum}`), sig);
}

/** wa.me deep link. Phone must be E.164 (+91…); WhatsApp wants digits only. */
export function whatsappLink(phone: string | null, message: string): string {
  const digits = phone?.replace(/\D/g, '') ?? '';
  const base = digits ? `https://wa.me/${digits}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(message)}`;
}
