// Shop offers applied by the server checkout: volume tiers, gift boxes, buy-X-get-Y
// and upsell discounts. Configuration lives in store_settings key `sell_more`
// (edited from the seller app) and store_upsell_offers. The storefront mirrors this
// algorithm in src/storefront/sellMore.ts for display only — this file is authoritative.

const pct = (minor, percent) => Math.round((minor * Math.min(100, Math.max(0, Number(percent) || 0))) / 100);

export async function loadSellMore(db, storeId) {
  const row = await db.one(`SELECT value FROM public.store_settings WHERE store_id=$1 AND key='sell_more'`, [storeId]);
  if (!row?.value) return {};
  try { const v = JSON.parse(row.value); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/**
 * rows: [{ product:{id,category_id}, bundle, qty, lineMinor, item }]
 * Mutates each row with `offerMinor` and returns { discount, applied:[{type,id,name,amount}] } in minor units.
 */
export async function applyOffers(db, storeId, rows, toMinor) {
  for (const r of rows) r.offerMinor = 0;
  const cfg = await loadSellMore(db, storeId);
  const applied = [];
  const now = Date.now();
  const live = (o) => o && o.active !== false && (!o.starts_at || Date.parse(o.starts_at) <= now) && (!o.ends_at || Date.parse(o.ends_at) > now);
  const unitOf = (r) => (r.qty ? r.lineMinor / r.qty : 0);
  const claimed = new Set(); // rows already discounted by a box/upsell are excluded from volume/bxgy

  // 1) Upsell lines: discount only when the offer is active and its trigger product is in the basket.
  const upsellIds = [...new Set(rows.map(r => r.item?.upsell_offer_id).filter(x => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))];
  if (upsellIds.length) {
    const offers = await db.q(`SELECT id,name,type,trigger_product_id,offer_product_id,discount_percent::text FROM public.store_upsell_offers WHERE store_id=$1 AND active=true AND id = ANY($2::uuid[])`, [storeId, upsellIds]);
    for (const r of rows) {
      const o = offers.find(x => x.id === r.item?.upsell_offer_id);
      if (!o || o.offer_product_id !== r.product.id || r.bundle) continue;
      const triggered = !o.trigger_product_id || rows.some(x => x !== r && x.product.id === o.trigger_product_id);
      if (!triggered || !(Number(o.discount_percent) > 0)) continue;
      const amount = pct(r.lineMinor, o.discount_percent);
      r.offerMinor += amount; claimed.add(r);
      applied.push({ type: 'upsell', id: o.id, name: o.name, amount });
    }
  }

  // 2) Gift boxes: complete sets of the box's products, tagged with the same gift_box_id.
  for (const box of Array.isArray(cfg.gift_boxes) ? cfg.gift_boxes : []) {
    if (!live(box) || !Array.isArray(box.product_ids) || box.product_ids.length < 2) continue;
    const lines = rows.filter(r => !r.bundle && !claimed.has(r) && r.item?.gift_box_id === box.id);
    const sets = Math.min(...box.product_ids.map(pid => lines.filter(r => r.product.id === pid).reduce((s, r) => s + r.qty, 0)));
    if (!sets || !Number.isFinite(sets)) continue;
    let full = 0;
    for (const pid of box.product_ids) { const r = lines.find(x => x.product.id === pid); full += unitOf(r) * sets; }
    const boxMinor = toMinor(box.price) * sets;
    const amount = Math.max(0, Math.round(full - boxMinor));
    if (!amount) continue;
    // Spread over the box lines proportionally.
    const boxLines = box.product_ids.map(pid => lines.find(x => x.product.id === pid));
    let left = amount;
    boxLines.forEach((r, i) => {
      const share = i === boxLines.length - 1 ? left : Math.round(amount * (unitOf(r) * sets) / full);
      r.offerMinor += share; left -= share; claimed.add(r);
    });
    applied.push({ type: 'gift_box', id: box.id, name: box.name, amount });
  }

  // 3) Volume tiers: best tier reached by the total eligible quantity of each rule.
  for (const rule of Array.isArray(cfg.volume) ? cfg.volume : []) {
    if (!live(rule) || !Array.isArray(rule.tiers)) continue;
    const match = (r) => rule.scope === 'products' ? (rule.product_ids || []).includes(r.product.id)
      : rule.scope === 'category' ? (rule.category_ids || []).includes(r.product.category_id) : true;
    const lines = rows.filter(r => !r.bundle && !claimed.has(r) && match(r));
    const qty = lines.reduce((s, r) => s + r.qty, 0);
    const tier = [...rule.tiers].filter(t => Number(t.min_qty) > 1 && qty >= Number(t.min_qty)).sort((a, b) => Number(b.min_qty) - Number(a.min_qty))[0];
    if (!tier) continue;
    let amount = 0;
    for (const r of lines) { const a = pct(r.lineMinor, tier.percent); r.offerMinor += a; amount += a; claimed.add(r); }
    if (amount) applied.push({ type: 'volume', id: rule.id, name: rule.name, amount, tier: Number(tier.min_qty) });
  }

  // 4) Buy X get Y: cheapest units in each complete group are discounted.
  for (const rule of Array.isArray(cfg.bxgy) ? cfg.bxgy : []) {
    if (!live(rule)) continue;
    const buy = Math.max(1, Number(rule.buy_qty) || 0), get = Math.max(1, Number(rule.get_qty) || 0);
    const ids = Array.isArray(rule.product_ids) ? rule.product_ids : [];
    const lines = rows.filter(r => !r.bundle && !claimed.has(r) && (!ids.length || ids.includes(r.product.id)));
    const units = lines.flatMap(r => Array.from({ length: Math.min(r.qty, 1000) }, () => ({ r, unit: unitOf(r) }))).sort((a, b) => a.unit - b.unit);
    const free = Math.floor(units.length / (buy + get)) * get;
    if (!free) continue;
    let amount = 0;
    for (const u of units.slice(0, free)) { const a = pct(u.unit, rule.get_percent ?? 100); u.r.offerMinor += a; amount += a; }
    for (const u of units) claimed.add(u.r);
    if (amount) applied.push({ type: 'bxgy', id: rule.id, name: rule.name, amount });
  }

  for (const r of rows) r.offerMinor = Math.min(r.offerMinor, r.lineMinor);
  const discount = rows.reduce((s, r) => s + r.offerMinor, 0);
  return { discount, applied };
}
