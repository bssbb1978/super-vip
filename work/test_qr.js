/* Verify the JS QR encoder module-by-module against python-qrcode (ground truth) */
const { execFileSync } = require('child_process');
globalThis.QV = { utf8: (s) => new TextEncoder().encode(s), b64: { enc: (b) => Buffer.from(b).toString('base64') } };
globalThis.crypto = globalThis.crypto || require('crypto').webcrypto;
eval(require('fs').readFileSync('core/44-qr.js', 'utf8'));

const cases = [
  { text: 'vless://admin@edge.example.com:443?security=tls&type=ws#QV-1', ec: 'M' },
  { text: 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@edge.example.com:443#QV-SS', ec: 'M' },
  { text: 'short', ec: 'L' },
  { text: 'x'.repeat(120), ec: 'M' },
  { text: 'y'.repeat(400), ec: 'Q' },
  { text: 'z'.repeat(800), ec: 'L' },
  { text: 'سلام — کانفیگ تست', ec: 'M' },
];

let fails = 0;
for (const c of cases) {
  let mine;
  try { mine = QV.qr.encode(c.text, { ec: c.ec, mask: 0 }); }
  catch (e) { console.log('❌ encode failed:', c.text.slice(0, 20), e.message); fails++; continue; }
  const py = JSON.parse(execFileSync('python3', ['-c', `
import qrcode, json, sys
qr = qrcode.QRCode(version=${mine.version}, error_correction=${c.ec === 'L' ? 'qrcode.constants.ERROR_CORRECT_L' : c.ec === 'M' ? 'qrcode.constants.ERROR_CORRECT_M' : c.ec === 'Q' ? 'qrcode.constants.ERROR_CORRECT_Q' : 'qrcode.constants.ERROR_CORRECT_H'}, box_size=1, border=0, mask_pattern=0)
qr.add_data(sys.argv[1].encode('utf8'))
qr.make(fit=False)
m = qr.get_matrix()
print(json.dumps(m))
`, c.text]).toString());
  const size = mine.size;
  if (py.length !== size) { console.log('❌ size mismatch', size, py.length); fails++; continue; }
  let diff = 0;
  for (let r = 0; r < size; r++) for (let c2 = 0; c2 < size; c2++) {
    if ((py[r][c2] ? 1 : 0) !== mine.modules[r][c2]) diff++;
  }
  const tag = diff === 0 ? '✅' : '❌';
  if (diff) fails++;
  console.log(`${tag} v${mine.version}/${mine.ec} mask0 size=${size} diff=${diff} (${JSON.stringify(c.text.slice(0, 24))})`);
}
console.log(fails ? `\n${fails} case(s) differ` : '\nall QR cases match python-qrcode exactly');
