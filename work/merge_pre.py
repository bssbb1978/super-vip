#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
merge_pre.py - Stage 1 of the merge: neutralise module syntax so the whole
concatenated file becomes ONE valid, parseable script body.

Rules (non-destructive: code is only commented / renamed, never dropped):
  1. `import ... from 'cloudflare:sockets'`  -> single hoisted import kept.
  2. `import { ... } from './x.js'` (files that do not exist) -> replaced by a
     destructuring from the unified shim object __QF_MODULES__ (so the original
     call sites keep working).
  3. `export default {`         -> `const __GEN_DEFAULT_<n> = {`
  4. `export [async] function X` -> `[async] function X`
  5. `export { a as default };`  -> commented out
  6. bare Arabic separator lines -> commented out
"""
import re, sys, json

def process(path, out):
    src = open(path, encoding='utf-8').read()
    report = {}

    # ---- 2/1: imports -----------------------------------------------------
    # capture whole import statements (may span lines)
    imp_re = re.compile(r"^import\s+(\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+['\"]([^'\"]+)['\"]\s*;?[ \t]*$", re.M | re.S)

    kept_sockets = []
    dead = []

    def imp_sub(m):
        clause, mod = m.group(1), m.group(2)
        if mod == 'cloudflare:sockets':
            kept_sockets.append(m.group(0))
            return "// [merged] hoisted to top of file: " + m.group(0).replace('\n', ' ')
        # non-existent sibling module -> shim lookup
        names = re.findall(r"[\w$]+\s+as\s+([\w$]+)|([\w$]+)", clause.replace('{', '').replace('}', ''))
        names = [(a or b).strip() for a, b in names if (a or b).strip()]
        dead.append((mod, names))
        return ("const { %s } = __QF_MODULES__['%s'] || {}; // [merged] shim for missing module %s"
                % (', '.join(names), mod, mod))

    src, n_imp = imp_re.subn(imp_sub, src)
    report['imports_rewritten'] = n_imp
    report['dead_modules'] = sorted({m for m, _ in dead})

    # ---- 3: export default ------------------------------------------------
    counter = [0]
    def exp_default(m):
        counter[0] += 1
        return "const __GEN_DEFAULT_%d = {" % counter[0]
    src, n_def = re.subn(r"^export\s+default\s*\{", exp_default, src, flags=re.M)
    # `export default foo;` style
    src, n_def2 = re.subn(r"^export\s+default\s+([\w$]+)\s*;", r"const __GEN_DEFAULT_REF_%d = \1;" % 0, src, flags=re.M)
    report['export_default'] = n_def + n_def2

    # ---- 4: export function/class/const ----------------------------------
    src, n_fn = re.subn(r"^export\s+(async\s+function|function|class|const|let|var)\b", r"\1", src, flags=re.M)
    report['export_decl'] = n_fn

    # ---- 5: export { ... }; re-export blocks -----------------------------
    def exp_block(m):
        body = m.group(0)
        return "/* [merged] removed module re-export:\n" + body + "\n*/"
    src, n_blk = re.subn(r"^export\s*\{[^}]*\}\s*;?", exp_block, src, flags=re.M | re.S)
    report['export_blocks'] = n_blk

    # ---- 6: bare separator junk lines ------------------------------------
    src, n_sep = re.subn(r"^و\s*$", "/* [merged] separator removed */", src, flags=re.M)
    report['separators'] = n_sep

    # ---- sourceMappingURL ------------------------------------------------
    src = src.replace("//# sourceMappingURL=entry.js.map", "/* [merged] sourceMappingURL removed */")

    open(out, 'w', encoding='utf-8').write(src)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if kept_sockets:
        print("\nSOCKETS IMPORTS FOUND:", len(kept_sockets))
        print(kept_sockets[0][:120])

if __name__ == '__main__':
    process(sys.argv[1], sys.argv[2])
