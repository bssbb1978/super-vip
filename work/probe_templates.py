#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import re, sys

TEMPLATE_START = re.compile(r"=\s*`\s*$|return\s+`\s*$|\(\s*`\s*$")
TEMPLATE_END = re.compile(r"^\s*`\s*;?\s*$")

src = open(sys.argv[1], encoding='utf-8').read()
lines = src.split('\n')
i = 0
while i < len(lines):
    if TEMPLATE_START.search(lines[i]):
        j = i + 1
        while j < len(lines) and not TEMPLATE_END.match(lines[j]):
            j += 1
        body = '\n'.join(lines[i+1:j])
        is_html = bool(re.search(r'<html|<!DOCTYPE|<script|<div|<body', body, re.I))
        bt = [k for k, ch in enumerate(body) if ch == '`']
        # count unescaped
        bt_u = len(re.findall(r'(?<!\\)`', body))
        doll = len(re.findall(r'(?<!\\)\$\{', body))
        print(f"lines {i+1}..{j+1}  html={is_html}  backticks={bt_u}  dollar_brace={doll}  len={len(body)}")
        print("    start:", lines[i][:100])
        if bt_u:
            for k in re.finditer(r'(?<!\\)`', body):
                s = max(0, k.start()-40)
                snip = body[s:k.start()+60].replace('\n', '\\n')
                print("      bt@", body[:k.start()].count('\n')+i+2, "|", snip[:150])
        i = j + 1
    else:
        i += 1
