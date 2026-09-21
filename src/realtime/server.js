// Realtime over WebSocket — reproduces the one channel the app subscribes to:
//   supabase.channel(`orders-new-${storeId}`)
//     .on('postgres_changes', { event:'INSERT', schema:'public', table:'orders',
//         filter:`store_id=eq.${storeId}` }, cb)
//
// The client connects to  ws://host/realtime/v1/websocket?apikey=...  and sends
// phx_join / heartbeat frames; we answer with the same envelope shape.
import { WebSocketServer } from 'ws';
import pg from 'pg';
import { config } from '../config.js';
import { verifyToken } from '../lib/jwt.js';
import { makeContext } from '../lib/context.js';

export function attachRealtime(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/realtime/v1/websocket' });
  /** @type {Set<{socket: import('ws').WebSocket, topics: Map<string, any>}>} */
  const clients = new Set();

  // ── LISTEN for row changes emitted by the realtime_changes trigger ──
  const listener = new pg.Client({ connectionString: config.databaseUrl });
  listener.connect().then(() => listener.query('LISTEN realtime_changes')).catch((e) =>
    console.error('[realtime] LISTEN failed:', e.message),
  );

  listener.on('notification', (msg) => {
    let payload;
    try { payload = JSON.parse(msg.payload); } catch { return; }
    // realtime-js converts every value through the `columns` list and throws if
    // it is missing, so the change payload must carry it like Supabase does.
    const columns = describeColumns(payload.record || payload.old_record || {});
    for (const client of clients) {
      for (const [topic, binding] of client.topics) {
        if (!matches(binding, payload)) continue;
        sendFrame(client, {
          topic,
          event: 'postgres_changes',
          ref: null,
          payload: {
            data: {
              schema: payload.schema,
              table: payload.table,
              type: payload.type,
              commit_timestamp: payload.commit_timestamp,
              columns,
              record: payload.record || {},
              old_record: payload.old_record || {},
              errors: null,
            },
            ids: [binding.id],
          },
        });
      }
    }
  });

  wss.on('connection', async (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('apikey') || '';
    let ctx = makeContext({});
    try {
      const claims = verifyToken(token);
      ctx = makeContext({ userId: claims.sub || null, role: claims.role || 'anon', claims });
    } catch { /* anon */ }

    const client = { socket, topics: new Map(), ctx };
    clients.add(client);

    socket.on('message', async (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      // Two Phoenix wire formats: vsn=1.0.0 sends objects, vsn=2.0.0 (what
      // @supabase/realtime-js actually uses) sends arrays
      // [join_ref, ref, topic, event, payload]. Replies must use the same
      // shape the client sent, so remember it per socket.
      if (Array.isArray(frame)) {
        client.v2 = true;
        const [joinRef, aref, atopic, aevent, apayload] = frame;
        frame = { join_ref: joinRef, ref: aref, topic: atopic, event: aevent, payload: apayload };
      }
      const { topic, event, payload, ref } = frame;
      client.joinRefs = client.joinRefs || new Map();
      if (event === 'phx_join') client.joinRefs.set(topic, frame.join_ref ?? ref);
      const send = (f) => sendFrame(client, { join_ref: client.joinRefs.get(f.topic) ?? null, ...f });

      // The signed-in user's JWT does not travel in the apikey query param:
      // realtime-js puts it in the join payload and refreshes it with an
      // 'access_token' frame (supabase-js calls realtime.setAuth on sign-in).
      const bearer = payload?.access_token || (event === 'access_token' ? payload?.access_token : null);
      if (bearer) {
        try {
          const claims = verifyToken(bearer);
          client.ctx = makeContext({ userId: claims.sub || null, role: claims.role || 'anon', claims });
        } catch { /* keep the previous context */ }
      }

      if (event === 'access_token') return;

      if (event === 'heartbeat') {
        return send({ topic: 'phoenix', event: 'phx_reply', ref, payload: { status: 'ok', response: {} } });
      }

      if (event === 'phx_join') {
        const binding = parseBinding(topic, payload);
        // Authorize: a store channel requires access to that store.
        if (binding.storeId && !(await client.ctx.hasStoreAccess(binding.storeId))) {
          return send({
            topic, event: 'phx_reply', ref,
            payload: { status: 'error', response: { reason: 'Unauthorized' } },
          });
        }
        client.topics.set(topic, binding);
        return send({
          topic, event: 'phx_reply', ref,
          payload: { status: 'ok', response: { postgres_changes: [{ ...binding.filterSpec, id: binding.id }] } },
        });
      }

      if (event === 'phx_leave') {
        client.topics.delete(topic);
        return send({ topic, event: 'phx_reply', ref, payload: { status: 'ok', response: {} } });
      }

      if (event === 'broadcast') {
        for (const other of clients) {
          if (other !== client && other.topics.has(topic)) sendFrame(other, { topic, event: 'broadcast', ref: null, payload });
        }
      }
    });

    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });

  // Keepalive.
  const ping = setInterval(() => { for (const c of clients) { try { c.socket.ping(); } catch { /* */ } } }, 30_000);
  wss.on('close', () => clearInterval(ping));

  return wss;
}

/** [{name,type}] for every column in the changed row (realtime-js requires it). */
function describeColumns(row) {
  return Object.entries(row).map(([name, value]) => ({
    name,
    type: value === null ? 'text'
      : typeof value === 'boolean' ? 'bool'
      : typeof value === 'number' ? (Number.isInteger(value) ? 'int8' : 'numeric')
      : typeof value === 'object' ? 'jsonb'
      : 'text',
  }));
}

let bindingSeq = 1;

function parseBinding(topic, payload) {
  const spec = payload?.config?.postgres_changes?.[0] || {};
  const filter = spec.filter || '';
  const m = filter.match(/^([A-Za-z0-9_]+)=eq\.(.+)$/);
  const column = m?.[1] || null;
  const value = m?.[2] || null;
  return {
    id: bindingSeq++,
    topic,
    filterSpec: spec,
    schema: spec.schema || 'public',
    table: spec.table || '*',
    event: (spec.event || '*').toUpperCase(),
    column,
    value,
    storeId: column === 'store_id' ? value : topic.match(/orders-new-([0-9a-f-]{36})/)?.[1] || null,
  };
}

function matches(binding, payload) {
  if (binding.schema !== payload.schema) return false;
  if (binding.table !== '*' && binding.table !== payload.table) return false;
  if (binding.event !== '*' && binding.event !== payload.type) return false;
  if (binding.column) {
    const row = payload.record || payload.old_record || {};
    if (String(row[binding.column] ?? '') !== String(binding.value)) return false;
  }
  return true;
}

function sendFrame(client, frame) {
  const socket = client.socket;
  if (socket.readyState !== 1) return;
  const { join_ref = null, ref = null, topic, event, payload } = frame;
  // Mirror the client's own encoding (see the message handler above).
  socket.send(client.v2
    ? JSON.stringify([join_ref, ref, topic, event, payload])
    : JSON.stringify({ topic, event, ref, payload }));
}
