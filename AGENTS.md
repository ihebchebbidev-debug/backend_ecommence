# Backend rules
- Merchant payments share version-aware paymentCrypto across save, probe, checkout and callbacks.
- Carrier calls use `sendProviderRequest`; startup seeds missing rows only, preserving admin choices. Run `bun scripts/export-delivery-presets.ts` after admin preset edits to sync the server mirror, so deployments populate the catalog.
- Seller automation webhooks (Zapier/Make) use a trigger-filled `automation_events` outbox drained by a server worker with retries; URLs stay in a REST-denied table and only official hook hosts are accepted, so orders are never lost or posted to arbitrary addresses.
