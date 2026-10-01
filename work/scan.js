/* Shared, hardened scanner: find the matching '}' for the '{' at index i,
   skipping strings, template literals (with ${} nesting) and comments. */
function findMatch(s, i) {
  let depth = 0, ln = 1; const st = []; const n = s.length;
  while (i < n) {
    const c = s[i];
    if (st.length === 0) {
      if (c === '`') { st.push('`'); i++; continue; }
      if (c === '"' || c === "'") { const q = c; i++; while (i < n && s[i] !== q) { i += (s[i] === '\\') ? 2 : 1; } i++; continue; }
      if (c === '/' && s[i + 1] === '/') { const j = s.indexOf('\n', i); i = j < 0 ? n : j + 1; continue; }
      if (c === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i); i = j < 0 ? n : j + 2; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
    } else if (st[st.length - 1] === '`') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { st.pop(); i++; continue; }
      if (c === '$' && s[i + 1] === '{') { st.push('{'); i += 2; continue; }
    } else if (st[st.length - 1] === '{') {
      if (c === '\\') { i += 2; continue; }
      if (c === '{') st.push('{');
      else if (c === '}') st.pop();
      else if (c === '`') st.push('`');
      else if (c === '"' || c === "'") { const q = c; i++; while (i < n && s[i] !== q) { i += (s[i] === '\\') ? 2 : 1; } i++; continue; }
    }
    i++;
  }
  return -1;
}
module.exports = { findMatch };
