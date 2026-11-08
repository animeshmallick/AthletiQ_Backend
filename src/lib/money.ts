/**
 * Money is stored and computed as integer paise to avoid floating-point errors.
 * Conversion to rupees happens only at the presentation edge.
 */
export type Paise = number;

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
});

/** e.g. 250000 → "₹2,500.00". */
export function formatInr(paise: Paise): string {
  return inr.format(paise / 100);
}

/** PDF fonts may lack the ₹ glyph; this variant uses "Rs." instead. */
export function formatInrAscii(paise: Paise): string {
  return `Rs. ${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 }).format(paise / 100)}`;
}
