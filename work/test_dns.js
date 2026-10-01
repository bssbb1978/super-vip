/* DNS codec + NAT64 self-test */
globalThis.QV = {
  utf8: (s) => new TextEncoder().encode(s),
  dec: new TextDecoder(),
  rand: (n) => crypto.getRandomValues(new Uint8Array(n)),
  rand16: () => crypto.getRandomValues(new Uint16Array(1))[0],
  concat: (...a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; },
  hex: (b) => [...b].map(x => x.toString(16).padStart(2, '0')).join(''),
  log: { warn: () => {}, error: () => {}, info: () => {} },
  emit: () => {}, safe: (f) => { try { return f(); } catch (e) {} }, safeAsync: (f) => { try { f(); } catch (e) {} },
  uuid: () => 'x', VERSION: 'test',
};
QV.b64 = {
  enc: (b) => Buffer.from(b).toString('base64'),
  dec: (s) => new Uint8Array(Buffer.from(String(s), 'base64')),
  url: (b) => Buffer.from(b).toString('base64url'),
  urlDec: (s) => new Uint8Array(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
};
QV.d1 = { Kv: { get: async () => null, set: async () => ({}) } };
globalThis.crypto = globalThis.crypto || require('crypto').webcrypto;

eval(require('fs').readFileSync('core/25-dns.js', 'utf8'));
const D = QV.dns;
const eq = (a, b, l) => console.log((JSON.stringify(a) === JSON.stringify(b) ? '✅' : '❌') + ' ' + l + (JSON.stringify(a) === JSON.stringify(b) ? '' : `\n    got ${JSON.stringify(a)}\n    exp ${JSON.stringify(b)}`));

/* NAT64 round trips */
eq(D.v4ToV6('104.16.132.229'), '64:ff9b::6810:84e5', 'v4→v6 well-known prefix');
eq(D.v6ToV4('64:ff9b::6810:84e5'), '104.16.132.229', 'v6→v4 well-known prefix');
eq(D.v6ToV4(D.v4ToV6('8.8.8.8', '64:ff9b:1::')), '8.8.8.8', 'v4→v6→v4 local-use prefix');
eq(D.v6ToV4(D.v4ToV6('1.1.1.1', '2606:4700:64::')), '1.1.1.1', 'v4→v6→v4 cloudflare prefix');
eq(D.unwrapTarget('64:ff9b::a29f:7e92').host, '162.159.126.146', 'unwrap NAT64 target (2a03:2880→?)'.slice(0, 0) || true ? '162.159.126.146' : '', 'unwrapTarget sanity');

/* message build → parse round trip */
const wire = D.build({
  id: 0x1234, flags: { qr: 1, rd: 1, ra: 1 },
  questions: [{ name: 'example.com', type: D.TYPE.A, class: D.CLASS.IN }],
  answers: [{ name: 'example.com', type: D.TYPE.A, ttl: 120, value: '93.184.216.34' }],
});
const m = D.parse(wire);
eq(m.id, 0x1234, 'id survives');
eq(m.questions[0].name, 'example.com', 'question name');
eq(m.answers[0].value, '93.184.216.34', 'A record value');
eq(m.answers[0].ttl, 120, 'TTL');

const wire6 = D.build({
  questions: [{ name: 'ipv6.example', type: D.TYPE.AAAA, class: D.CLASS.IN }],
  answers: [{ name: 'ipv6.example', type: D.TYPE.AAAA, ttl: 60, value: '2606:4700:4700::1111' }],
});
eq(D.parse(wire6).answers[0].value, '2606:4700:4700:0:0:0:0:1111', 'AAAA record encode/decode');

/* CNAME + TXT + MX */
const mixed = D.build({
  questions: [{ name: 'x.test', type: D.TYPE.A, class: D.CLASS.IN }],
  answers: [
    { name: 'x.test', type: D.TYPE.CNAME, ttl: 60, value: 'real.test' },
    { name: 'real.test', type: D.TYPE.A, ttl: 60, value: '1.2.3.4' },
    { name: 'x.test', type: D.TYPE.TXT, ttl: 60, value: 'hello world' },
    { name: 'x.test', type: D.TYPE.MX, ttl: 60, value: { pref: 10, host: 'mail.x.test' } },
  ],
});
const mm = D.parse(mixed);
eq(mm.answers.map(a => a.typeName), ['CNAME', 'A', 'TXT', 'MX'], 'RR type sequence');
eq(mm.answers[0].value, 'real.test', 'CNAME target');
eq(mm.answers[2].value, 'hello world', 'TXT value');
eq(mm.answers[3].value.pref, 10, 'MX preference');

/* poisoning detector */
const poisoned = D.parse(D.build({
  questions: [{ name: 'blocked.example', type: D.TYPE.A }],
  answers: [{ name: 'blocked.example', type: D.TYPE.A, ttl: 300, value: '10.10.34.34' }],
}));
eq(D.isPoisoned(poisoned).poisoned, true, 'sinkhole 10.10.34.34 detected');
const clean = D.parse(D.build({
  questions: [{ name: 'ok.example', type: D.TYPE.A }],
  answers: [{ name: 'ok.example', type: D.TYPE.A, ttl: 300, value: '93.184.216.34' }],
}));
eq(D.isPoisoned(clean).poisoned, false, 'clean answer accepted');

/* DNS64 synthesis */
const aOnly = D.parse(D.build({
  questions: [{ name: 'v4only.example', type: D.TYPE.AAAA }],
  answers: [{ name: 'v4only.example', type: D.TYPE.A, ttl: 300, value: '203.0.113.9' }],
}));
const syn = D.synthesize(aOnly);
eq(syn.answers[0].value, '64:ff9b::cb00:7109', 'DNS64 synthesis');

/* tcp framing */
const framed = QV.concat(D.frameTcp(wire), D.frameTcp(wire6));
const un = D.unframeTcp(framed);
eq(un.messages.length, 2, 'tcp frame count');
eq(un.messages[1].length, wire6.length, 'tcp frame payload length');
const partial = D.unframeTcp(QV.concat(D.frameTcp(wire), new Uint8Array([0, 50, 1, 2])));
eq([partial.messages.length, partial.rest.length], [1, 4], 'partial frame kept in rest');

/* live upstream test (network permitting) */
(async () => {
  try {
    const q = D.build({ id: 0xbeef, flags: { rd: 1 }, questions: [{ name: 'cloudflare.com', type: D.TYPE.A }] });
    const { msg, source } = await D.resolve({}, null, q);
    console.log((msg.answers.some(a => a.type === D.TYPE.A) ? '✅' : '❌') + ' live DoH resolve via ' + source + ' → ' +
      msg.answers.filter(a => a.type === D.TYPE.A).map(a => a.value).join(', '));
  } catch (e) { console.log('⚠️  live DoH test skipped: ' + e.message); }
})();
