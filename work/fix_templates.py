#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_templates.py  (v2, conservative)

Repairs nested template literals inside LARGE HTML templates.

A multi-line template is repaired only when ALL of these hold:
  1. it is introduced by a line ending in `= \``  (an assignment)
  2. it is closed by a line consisting only of  `  or  `;   (optional indent)
  3. its body contains real HTML markers (<html, <!doctype, <script, <body, <div)

Inside such a template every inner template literal (`` `...` ``) is escaped
  `  ->  \`
  ${ ->  \${   (only between the inner pair)
so the outer template still evaluates to exactly the intended literal text
while the embedded client-side JavaScript survives intact.
"""
import re, sys

START = re.compile(r"=\s*`\s*$")
END = re.compile(r"^\s*`\s*;?\s*$")
HTML = re.compile(r"<html|<!doctype|<script|<body|<div|</head>", re.I)

def escape_inner(text):
    out, i, n, count = [], 0, len(text), 0
    while i < n:
        c = text[i]
        if c == '\\':
            out.append(text[i:i + 2]); i += 2; continue
        if c == '`':
            k, depth = i + 1, 0
            while k < n:
                ch = text[k]
                if ch == '\\':
                    k += 2; continue
                if ch == '$' and k + 1 < n and text[k + 1] == '{':
                    depth += 1; k += 2; continue
                if ch == '}' and depth > 0:
                    depth -= 1; k += 1; continue
                if ch == '`' and depth == 0:
                    break
                k += 1
            if k >= n:
                out.append('\\`'); i += 1; count += 1; continue
            inner = text[i + 1:k].replace('`', '\\`').replace('${', '\\${')
            out.append('\\`' + inner + '\\`')
            i = k + 1; count += 1; continue
        out.append(c); i += 1
    return ''.join(out), count

def fix(src):
    lines = src.split('\n')
    i, changed = 0, []
    while i < len(lines):
        if START.search(lines[i]):
            j = i + 1
            while j < len(lines) and not END.match(lines[j]):
                j += 1
            if j < len(lines):
                body = '\n'.join(lines[i + 1:j])
                if HTML.search(body) and '`' in body:
                    new_body, n = escape_inner(body)
                    if n:
                        lines[i + 1:j] = new_body.split('\n')
                        changed.append((i + 2, j, n))
                    i = j + 1
                    continue
            i += 1
        else:
            i += 1
    return '\n'.join(lines), changed

if __name__ == '__main__':
    src = open(sys.argv[1], encoding='utf-8').read()
    fixed, changed = fix(src)
    open(sys.argv[2], 'w', encoding='utf-8').write(fixed)
    print(f"HTML templates repaired: {len(changed)}")
    for a, b, n in changed:
        print(f"   lines {a}..{b + 1}   inner templates escaped: {n}")
