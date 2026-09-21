// /rest/v1/rpc/:fn — the 62 database functions, re-implemented in Node.js.
//
// Every handler has the signature `(args, ctx) => value` where `value` is the
// exact JSON the Supabase RPC returned:
//   • `Returns: X[]`      → return an array of rows
//   • `Returns: Json`     → return the object/array as-is
//   • `Returns: boolean`  → return a boolean
//   • `Returns: void`     → return null
import express from 'express';
import { asyncHandler, notFound } from '../lib/errors.js';

import authRpc from './auth.js';
import storesRpc from './stores.js';
import ordersRpc from './orders.js';
import agentsRpc from './agents.js';
import clientsRpc from './clients.js';
import productsRpc from './products.js';
import deliveryRpc from './delivery.js';
import paymentsRpc from './payments.js';
import storefrontRpc from './storefront.js';
import billingRpc from './billing.js';
import adminRpc from './admin.js';
import helpersRpc from './helpers.js';

export const rpcRegistry = {
  ...authRpc,
  ...storesRpc,
  ...ordersRpc,
  ...agentsRpc,
  ...clientsRpc,
  ...productsRpc,
  ...deliveryRpc,
  ...paymentsRpc,
  ...storefrontRpc,
  ...billingRpc,
  ...adminRpc,
  ...helpersRpc,
};

export const rpcRouter = express.Router();

const handle = asyncHandler(async (req, res) => {
  const { fn } = req.params;
  const impl = Object.prototype.hasOwnProperty.call(rpcRegistry, fn) ? rpcRegistry[fn] : null;
  if (!impl) throw notFound(`Could not find the function public.${fn} in the schema cache`, { code: 'PGRST202' });

  const args = req.method === 'GET' ? req.query : req.body || {};
  const result = await impl(args, req.ctx);

  // PostgREST returns `null` (not an empty body) for void functions.
  const payload = result === undefined ? null : result;

  if (String(req.headers.accept || '').includes('vnd.pgrst.object')) {
    const row = Array.isArray(payload) ? payload[0] ?? null : payload;
    return res.status(200).json(row);
  }
  return res.status(200).json(payload);
});

rpcRouter.post('/:fn', handle);
rpcRouter.get('/:fn', handle);
