import tls from 'node:tls';

// Connect only to configured platform addresses, never to an arbitrary DNS target.
export function checkCertificate(host, ip, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false;
    let socket;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket?.destroy();
      resolve(result);
    };
    socket = tls.connect({ host: ip, port: 443, servername: host, rejectUnauthorized: true }, () => {
      const cert = socket.getPeerCertificate();
      const expires = Date.parse(cert.valid_to);
      finish({ ready: socket.authorized && Number.isFinite(expires) && expires > Date.now(),
        expires_at: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
        reason: socket.authorized ? null : 'invalid_certificate' });
    });
    socket.setTimeout(timeout, () => finish({ ready: false, reason: 'timeout' }));
    socket.on('error', (err) => finish({ ready: false, reason: String(err.code || 'tls_unavailable') }));
  });
}

export function healthChecks(domain, dns, https, linked) {
  const ips = dns.expected.join(', ');
  return [
    { key: 'root', label: 'Root DNS', ready: dns.root,
      message: dns.root ? 'Your domain points only to the shop server.' : `Your domain points to ${dns.found.root.join(', ') || 'no address'} instead of the shop server.`,
      fix: dns.root ? null : `Set the @ A record to ${ips}. Remove conflicting A and AAAA records for @. Keep all email records.` },
    { key: 'www', label: 'WWW DNS', ready: dns.www,
      message: dns.www ? 'The www address points only to the shop server.' : `www.${domain} points to ${dns.found.www.join(', ') || 'no address'} instead of the shop server.`,
      fix: dns.www ? null : 'Set the www CNAME shown below. Remove conflicting www A/AAAA records and turn off DNS proxying or URL forwarding.' },
    { key: 'ownership', label: 'Ownership proof', ready: dns.ownership,
      message: dns.ownership ? 'The TXT record matches this connection.' : 'The required TXT ownership proof is missing or does not match this connection.',
      fix: dns.ownership ? null : `Set TXT _e-commence to ${dns.expected_proof}. Replace any old e-commence verification value, then check again.` },
    { key: 'link', label: 'Shop connection', ready: linked,
      message: linked ? 'This domain is linked to your selected shop.' : 'This domain is not yet linked to your selected shop.',
      fix: linked ? null : 'Fix the DNS and ownership checks, then check again to connect this shop automatically.' },
    ...['root', 'www'].map((key) => ({ key: `https_${key}`, label: key === 'root' ? 'Root HTTPS certificate' : 'WWW HTTPS certificate',
      ready: https[key].ready,
      message: https[key].ready ? `A trusted HTTPS certificate is ready${https[key].expires_at ? ` until ${https[key].expires_at.slice(0, 10)}` : ''}.` : https[key].reason === 'dns_not_ready' ? 'HTTPS has not been checked because DNS or ownership is not ready.' : 'A trusted HTTPS connection could not be confirmed yet.',
      fix: https[key].ready ? null : !dns.ok ? 'Fix the DNS and TXT checks first, then check again.' : 'Wait a few minutes, then check again. If it still fails, ask platform support to check certificate issuance, ports 80/443 and your CAA records.' })),
  ];
}