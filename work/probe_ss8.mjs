/* drive QV.ss.SSStream directly (module scope sets globalThis.QV) */
const mod = await import('./dist/worker.mjs');
const QV = globalThis.QV;
const dec = (r) => (r.pieces || []).map(p => Buffer.from(p).toString('utf8')).join('|');
for (const cipher of ['2022-blake3-chacha20-poly1305', '2022-blake3-aes-256-gcm', 'chacha20-ietf-poly1305']) {
  const password = cipher.startsWith('2022') ? QV.b64.enc(QV.rand(32)) : 'legacy-pass';
  const client = new QV.ss.SSStream({ cipher, password, isServer: false });
  const server = new QV.ss.SSStream({ cipher, password, isServer: true });
  const w1 = await client.push(QV.utf8('first-chunk'));
  const r1 = await server.pull(w1);
  const w2 = await client.push(QV.utf8('second-chunk'));
  const r2 = await server.pull(w2);
  console.log(cipher.padEnd(32), 'r1=' + JSON.stringify(dec(r1)) + (r1.error ? ' ERR:' + r1.error : ''), '| r2=' + JSON.stringify(dec(r2)) + (r2.error ? ' ERR:' + r2.error : ''), '| wire1=' + w1.length + ' wire2=' + w2.length);
}
