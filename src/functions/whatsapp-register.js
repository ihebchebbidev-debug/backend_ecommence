// Port of supabase/functions/whatsapp-register/index.ts
import { json, methodGuard } from './_shared/respond.js';

const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';
const GRAPH_VER = 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VER}`;

async function requireSuperAdmin(ctx) {
  if (!ctx.userId) return { ok: false, status: 401, error: 'Unauthorized' };
  const roleRow = await ctx.q('SELECT role FROM public.admin_roles WHERE user_id=$1', [ctx.userId]).then((r) => r[0]);
  if (roleRow?.role !== 'super_admin' && roleRow?.role !== 'limited_super_admin') {
    return { ok: false, status: 403, error: 'Forbidden: super admin only' };
  }
  return { ok: true };
}

async function resolveCredentials(ctx) {
  const envToken = process.env.WHATSAPP_PERMANENT_ACCESS_TOKEN;
  const envNumId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const envPin = process.env.WHATSAPP_TWO_STEP_PIN;

  if (envToken && envNumId && envPin) {
    return { accessToken: envToken, phoneNumberId: envNumId, twoStepPin: envPin };
  }

  const data = await ctx.q(
    'SELECT access_token, phone_number_id, whatsapp_two_step_pin FROM public.phone_verification_settings WHERE id=$1',
    [SETTINGS_ID],
  ).then((r) => r[0]);

  return {
    accessToken: envToken || data?.access_token || null,
    phoneNumberId: envNumId || data?.phone_number_id || null,
    twoStepPin: envPin || data?.whatsapp_two_step_pin || null,
  };
}

async function registerNumber(ctx, res, pin) {
  const creds = await resolveCredentials(ctx);

  if (!creds.accessToken) return json(res, { error: 'Access Token non configuré. Sauvegardez-le dans les credentials WhatsApp Business.' }, 400);
  if (!creds.phoneNumberId) return json(res, { error: 'Phone Number ID non configuré.' }, 400);
  if (!pin || !/^\d{6}$/.test(pin)) return json(res, { error: 'Le PIN doit contenir exactement 6 chiffres.' }, 400);

  let metaStatus = 'error';
  let metaError = null;
  let registeredAt = null;

  try {
    const apiRes = await fetch(`${GRAPH_BASE}/${creds.phoneNumberId}/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });

    const respJson = await apiRes.json();

    if (apiRes.ok && respJson.success === true) {
      metaStatus = 'registered';
      registeredAt = new Date().toISOString();
    } else {
      const errObj = respJson.error ?? {};
      metaError = errObj.message ?? errObj.error_data?.details ?? JSON.stringify(respJson);
    }

    await ctx.q(
      `UPDATE public.phone_verification_settings SET whatsapp_registration_status=$1, whatsapp_registration_error=$2, whatsapp_registered_at=$3 WHERE id=$4`,
      [metaStatus, metaError, registeredAt, SETTINGS_ID],
    );

    if (metaStatus === 'registered') return json(res, { success: true, message: 'Numéro enregistré avec Meta Cloud API.' });
    return json(res, { success: false, error: metaError }, 400);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur réseau vers Meta';
    await ctx.q(
      `UPDATE public.phone_verification_settings SET whatsapp_registration_status='error', whatsapp_registration_error=$1 WHERE id=$2`,
      [msg, SETTINGS_ID],
    );
    return json(res, { success: false, error: msg }, 500);
  }
}

async function sendTestMessage(ctx, res, to, message) {
  const creds = await resolveCredentials(ctx);

  if (!creds.accessToken) return json(res, { error: 'Access Token non configuré.' }, 400);
  if (!creds.phoneNumberId) return json(res, { error: 'Phone Number ID non configuré.' }, 400);
  if (!to) return json(res, { error: 'Numéro destinataire manquant.' }, 400);

  const normalizedTo = to.replace(/\s+/g, '').replace(/^\+?/, '+');

  try {
    const apiRes = await fetch(`${GRAPH_BASE}/${creds.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: normalizedTo,
        type: 'text',
        text: { body: message || 'Message test depuis la plateforme e-commerce.' },
      }),
    });

    const respJson = await apiRes.json();

    if (apiRes.ok && (respJson.messages || respJson.message_id)) {
      return json(res, { success: true, data: respJson });
    }
    const errObj = respJson.error ?? {};
    const errMsg = errObj.message ?? JSON.stringify(respJson);
    return json(res, { success: false, error: errMsg }, 400);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur réseau vers Meta';
    return json(res, { success: false, error: msg }, 500);
  }
}

export default async function whatsappRegister(req, res, ctx) {
  if (methodGuard(req, res)) return;

  const auth = await requireSuperAdmin(ctx);
  if (!auth.ok) return json(res, { error: auth.error }, auth.status);

  try {
    const body = req.body || {};
    const action = body.action;

    if (action === 'register') return await registerNumber(ctx, res, String(body.pin ?? ''));
    if (action === 'send_test') return await sendTestMessage(ctx, res, String(body.to ?? ''), String(body.message ?? ''));

    return json(res, { error: `Action inconnue: ${action}` }, 400);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    console.error('whatsapp-register error:', msg);
    return json(res, { error: msg }, 500);
  }
}
