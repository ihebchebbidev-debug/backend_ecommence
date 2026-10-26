// Compatibility route: seller diagnostics may only send synthetic Test Events
// using the shop's saved pixel/code. Customer events belong to storefront-meta-event.
import metaCapiConfig from './meta-capi-config.js';

export default async function metaCapi(req, res, ctx) {
  return metaCapiConfig({ ...req, method: req.method, body: { store_id: req.body?.store_id, action: 'test' } }, res, ctx);
}
