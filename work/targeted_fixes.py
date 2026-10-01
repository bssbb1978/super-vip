#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
targeted_fixes.py — explicit, documented, minimal repairs for defects that a
generic hill-climbing repair cannot solve.

FIX #1 — truncated HTML template without a closing delimiter
-----------------------------------------------------------
Pattern in the source:
      const ADMIN_PANEL_HTML = `
      ... html ...
      <style> ... (content is cut off in the original file) ...
      /**  <-- the next generation's banner starts here

Every statement that follows is swallowed as template text, producing a cascade
of parse errors far from the real defect.

Rule (HTML templates only):
   * search forward for `</html>`
       – found  -> the template is properly closed; leave it alone
       – missing-> the markup was truncated: re-insert the closing delimiter
                   (`; ) at the end of the last content line, immediately
                   before the next banner/segment boundary.
"""
import re, sys

def fix_missing_template_close(src):
    """Return (new_src, [names]) - only truncated HTML templates are touched."""
    lines = src.split('\n')
    out, i, fixes = [], 0, []
    while i < len(lines):
        out.append(lines[i])
        m = re.match(r'^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*`\s*$', lines[i])
        if m:
            name = m.group(1)
            limit = min(len(lines), i + 8000)
            html_open = -1
            html_close = -1
            def is_real_boundary(k):
                """banner/comment block followed by a top-level declaration"""
                if not re.match(r'^\s*(/\*\*|// ═)', lines[k]):
                    return False
                for t in range(k + 1, min(len(lines), k + 10)):
                    if re.match(r'^(const|class|function|async|export|let|var)\s', lines[t]):
                        return True
                return False
            for j in range(i + 1, limit):
                if is_real_boundary(j):
                    break
                if html_open < 0 and re.search(r'<html|<!doctype', lines[j], re.I):
                    html_open = j
                if html_open >= 0 and '</html>' in lines[j]:
                    html_close = j
                    break
            if html_open >= 0 and html_close < 0:
                # real HTML template that never closes -> markup was truncated
                k = html_open
                while k < len(lines) and not (
                        re.match(r'^\s*/\*\*', lines[k]) or
                        re.match(r'^\s*// ═══+', lines[k]) or
                        re.match(r'^\s*(?:const|class|function|export|async)\s', lines[k])):
                    k += 1
                while i + 1 < k:
                    i += 1
                    out.append(lines[i])
                while out and out[-1].strip() == '':
                    out.pop()
                out.append('`;  /* [restored] closing delimiter re-inserted — template truncated in source */')
                out.append('')
                fixes.append(name)
        i += 1
    return '\n'.join(out), fixes

if __name__ == '__main__':
    src = open(sys.argv[1], encoding='utf-8').read()
    out, fixes = fix_missing_template_close(src)
    open(sys.argv[2], 'w', encoding='utf-8').write(out)
    print(f"restored closing delimiters: {len(fixes)}  -> {fixes}")
