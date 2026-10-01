#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Repair engine #2 — fixes method bodies of the form:
      async foo(args) { try {
         <body>
      }
   (try block with NO catch/finally)  ->  appends a guarded catch clause.
Scanner is string/template/comment aware and brace-balanced.
"""
import re, sys

def skipper(s, i, n):
    """skip whitespace + comments from i; return index of next code char"""
    while i < n:
        c = s[i]
        if c in ' \t\r\n':
            i += 1; continue
        if c == '/' and i + 1 < n and s[i+1] == '/':
            j = s.find('\n', i); i = n if j < 0 else j + 1; continue
        if c == '/' and i + 1 < n and s[i+1] == '*':
            j = s.find('*/', i); i = n if j < 0 else j + 2; continue
        return i
    return i

def match_brace(s, i, n):
    """s[i] == '{' -> index of matching '}' ; string/template/comment aware"""
    depth = 0
    tstack = []
    while i < n:
        c = s[i]
        if c == '\\':
            i += 2; continue
        if tstack and tstack[-1] == '`':
            if c == '`': tstack.pop()
            elif c == '$' and i+1 < n and s[i+1] == '{': tstack.append('{')
            i += 1; continue
        if tstack and tstack[-1] == '{':
            if c == '{': tstack.append('{')
            elif c == '}': tstack.pop()
            elif c == '`': tstack.append('`')
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
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1

GUARD = ("catch (__autoErr) { try { (typeof recordSyncError === 'function') && "
         "recordSyncError('body-guard', __autoErr); } catch (__e2) {} "
         "console.error('[guard]', (__autoErr && __autoErr.message) || __autoErr); }")

def repair(path):
    s = open(path, encoding='utf-8').read()
    n = len(s)
    out_fixes = 0
    # iterate fresh each pass because offsets shift
    changed = True
    while changed:
        changed = False
        for m in re.finditer(r'\{ try \{', s):
            # position of the try block brace
            brace_idx = s.index('{', m.end() - 3) if False else m.end() - 1
            # find matching '}' of the try block starting at brace_idx
            close = match_brace(s, brace_idx, len(s))
            if close < 0:
                continue
            nxt = skipper(s, close + 1, len(s))
            word = s[nxt:nxt+8]
            if word.startswith('catch') or word.startswith('finally'):
                continue
            # Only treat as repairable when the next code char is the method's closing '}'
            if nxt < len(s) and s[nxt] == '}':
                s = s[:close+1] + ' ' + GUARD + ' ' + s[close+1:]
                out_fixes += 1
                changed = True
                break
    open(path, 'w', encoding='utf-8').write(s)
    return out_fixes

if __name__ == '__main__':
    print("guard-catch inserted:", repair(sys.argv[1]))
