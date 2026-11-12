// Platform-wide on/off switch for each shop payment method (super admin → /admin/payment).
// Stored in platform_settings as `payment_method_<code>_enabled`; a missing row means ON,
// only the literal value 'false' switches a method off for every shop.

export const PLATFORM_PAYMENT_METHODS = ['stripe', 'konnect', 'paymee', 'flouci', 'clictopay'];

export const paymentMethodSettingKey = (code) => `payment_method_${code}_enabled`;

/** SQL predicate: true unless the platform switched off the provider named by `providerSql`. */
export const platformAllowsPaymentSql = (providerSql) =>
  `NOT EXISTS (SELECT 1 FROM public.platform_settings pms
     WHERE pms.key = 'payment_method_' || ${providerSql} || '_enabled'
       AND lower(trim(coalesce(pms.value, ''))) = 'false')`;

/** True unless the platform switched this payment method off. */
export async function isPlatformPaymentMethodEnabled(ctx, code) {
  const rows = await ctx.q('SELECT value FROM public.platform_settings WHERE key = $1', [paymentMethodSettingKey(code)]);
  return String(rows?.[0]?.value ?? '').trim().toLowerCase() !== 'false';
}
