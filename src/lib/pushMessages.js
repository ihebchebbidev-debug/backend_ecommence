// Pure push message builder (no database imports) so it can be tested alone.
export const TEXT = {
  fr: { order_created: 'Nouvelle commande', order_cancelled: 'Commande annulée', payment_received: 'Paiement reçu', payment_mismatch: 'Paiement à vérifier : montant ou devise différent', low_stock: 'Stock faible', plan_quota: 'Alerte quota de votre formule', plan_update: 'Mise à jour de votre abonnement', experiment_ended: 'Test A/B terminé : un gagnant est sûr à 99 %' },
  en: { order_created: 'New order', order_cancelled: 'Order cancelled', payment_received: 'Payment received', payment_mismatch: 'Payment to check: different amount or currency', low_stock: 'Low stock', plan_quota: 'Plan quota alert', plan_update: 'Subscription update', experiment_ended: 'A/B test ended: a winner is 99 % certain' },
  ar: { order_created: 'طلب جديد', order_cancelled: 'تم إلغاء الطلب', payment_received: 'تم استلام الدفع', payment_mismatch: 'دفع يحتاج مراجعة: المبلغ أو العملة مختلف', low_stock: 'المخزون منخفض', plan_quota: 'تنبيه حصة باقتك', plan_update: 'تحديث على اشتراكك', experiment_ended: 'انتهى اختبار A/B: فائز مؤكد بنسبة 99 %' },
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

