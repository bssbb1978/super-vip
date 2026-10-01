#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Repair engine #1 for index1.js — fixes unterminated ternary expressions:
    await (this.db ? <EXPR>;            ->  await (this.db ? <EXPR> : null);
    const r = await (this.db ? <EXPR>;  ->  const r = await (this.db ? <EXPR> : null);
Template-literal / string / comment aware, paren-balanced, reverse-order safe.
"""
import re, sys

def scan_expr_end(s, i):
    dp = db = dk = 0
    tstack = []
    n = len(s)
    while i < n:
        c = s[i]
        if c == '\\':
            i += 2; continue
        if tstack and tstack[-1] == '`':
            if c == '\\':
                i += 2; continue
            if c == '`':
                tstack.pop(); i += 1; continue
            if c == '$' and i + 1 < n and s[i+1] == '{':
                tstack.append('{'); i += 2; continue
            i += 1; continue
        if tstack and tstack[-1] == '{':
            if c == '{': tstack.append('{')
            elif c == '}': tstack.pop()
            elif c == '`': tstack.append('`')
            elif c in '"\'':
                q = c; i += 1
                while i < n and s[i] != q:
                    i += 2 if s[i] == '\\' else 1
            i += 1; continue
        if c == '`':
            tstack.append('`'); i += 1; continue
        if c in '"\'':
            q = c; i += 1
            while i < n and s[i] != q:
                i += 2 if s[i] == '\\' else 1
            i += 1; continue
        if c == '/' and i + 1 < n and s[i+1] == '/':
            j = s.find('\n', i); i = n if j < 0 else j + 1; continue
        if c == '/' and i + 1 < n and s[i+1] == '*':
            j = s.find('*/', i); i = n if j < 0 else j + 2; continue
        if c == '(': dp += 1
        elif c == ')': dp -= 1
        elif c == '{': db += 1
        elif c == '}': db -= 1
        elif c == '[': dk += 1
        elif c == ']': dk -= 1
        elif c == ';' and dp <= 0 and db <= 0 and dk <= 0:
            return i
        i += 1
    return n

def balance(core):
    dp = db = dk = 0
    tstack = []
    for c in core:
        if tstack:
            if c == '`': tstack.pop()
            continue
        if c == '`': tstack.append('`'); continue
        if c == '(': dp += 1
        elif c == ')': dp -= 1
        elif c == '{': db += 1
        elif c == '}': db -= 1
        elif c == '[': dk += 1
        elif c == ']': dk -= 1
    return dp, db, dk

def repair(path):
    s = open(path, encoding='utf-8').read()
    matches = list(re.finditer(r'await \(this\.db \? ', s))
    fixed = skipped = 0
    for m in reversed(matches):
        start_q = m.end()
        semi = scan_expr_end(s, start_q)
        seg = s[start_q:semi]
        if re.search(r':\s*(null|undefined|Promise\.resolve\(\)|\[\]|\{\})\s*\)\s*$', seg.rstrip()):
            skipped += 1; continue
        core = seg.rstrip()
        # strip unmatched trailing closers that belonged to the outer paren
        while True:
            dp, db, dk = balance(core)
            if dp < 0 and core.endswith(')'):
                core = core[:-1].rstrip()
            elif db < 0 and core.endswith('}'):
                core = core[:-1].rstrip()
            else:
                break
        repl = 'await (this.db ? ' + core + ' : null);'
        s = s[:m.start()] + repl + s[semi+1:]
        fixed += 1
    open(path, 'w', encoding='utf-8').write(s)
    return fixed, skipped, len(matches)

if __name__ == '__main__':
    print("fixed/skipped/total:", repair(sys.argv[1]))
