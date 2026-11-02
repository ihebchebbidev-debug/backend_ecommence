/** Browser outcomes are navigation only; callbacks still verify the provider. */
export function publicHttpsBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new Error('Invalid public payment URL');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function storePaymentUrls(store, provider, env = process.env) {
  if (!store?.id || !/^[a-z0-9_-]+$/i.test(store.slug || '')) throw new Error('Invalid shop address');
  const platform = publicHttpsBase(env.PUBLIC_STOREFRONT_URL || 'https://e-commence.shop');
  // Use only an activated domain selected by the server, never a request Origin.
  const origin = store.payment_domain ? publicHttpsBase(`https://${store.payment_domain}`) : platform;
  const base = `${origin}/store/${encodeURIComponent(store.slug)}`;
  const callback = new URL(`${publicHttpsBase(env.PUBLIC_FUNCTIONS_BASE_URL || env.PUBLIC_URL)}/functions/v1/store-payment-callback`);
  callback.searchParams.set('store_id', store.id);
  callback.searchParams.set('provider', provider);
  const outcome = status => `${base}/order?status=${status}`;
  return { store_id: store.id, provider, shop_url: base, success_url: outcome('success'), fail_url: outcome('failed'), cancel_url: outcome('cancelled'), webhook_url: callback.href };
}

export async function readPaymentStore(ctx, id) {
  return ctx.q(`SELECT s.id, s.slug, s.status,
    CASE WHEN EXISTS (SELECT 1 FROM public.store_domain_requests r WHERE r.store_id=s.id AND lower(r.domain)=lower(s.store_domain) AND r.status='active') THEN s.store_domain ELSE NULL END AS payment_domain
    FROM public.platform_stores s WHERE s.id=$1 AND s.deleted_at IS NULL`, [id]).then(rows => rows[0]);
}

export function paymentAttemptUrls(urls, orderId, orderNumber) {
  const build = raw => {
    const url = new URL(raw);
    url.pathname += `/${encodeURIComponent(orderNumber)}`;
    url.searchParams.set('order', orderId);
    return url.href;
  };
  return { successUrl: build(urls.success_url), failUrl: build(urls.fail_url), cancelUrl: build(urls.cancel_url), webhook: urls.webhook_url };
}