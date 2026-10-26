// Pure push message builder (no database imports) so it can be tested alone.
export const TEXT = {
  fr: { order_created: 'Nouvelle commande', order_cancelled: 'Commande annulée', payment_received: 'Paiement reçu', low_stock: 'Stock faible' },
  en: { order_created: 'New order', order_cancelled: 'Order cancelled', payment_received: 'Payment received', low_stock: 'Low stock' },
  ar: { order_created: 'طلب جديد', order_cancelled: 'تم إلغاء الطلب', payment_received: 'تم استلام الدفع', low_stock: 'المخزون منخفض' },
};

/** Builds the redacted message for one device. Exported for tests. */
export function pushMessage(device, n) {
  const lang = TEXT[device.language] ? device.language : 'fr';
  const number = n.data && (typeof n.data.order_number === 'string' || typeof n.data.order_number === 'number') ? String(n.data.order_number) : '';
  return {
    to: device.token, sound: 'default', priority: 'high', channelId: 'orders',
    title: TEXT[lang][n.type] ?? TEXT[lang].order_created,
    body: number ? `#${number}` : undefined,
    data: { notification_id: n.id, type: n.type, source_id: n.source_id, store_id: n.store_id },
  };
}

