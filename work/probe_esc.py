#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import re

src = open('/home/user/uploads/index1.js', encoding='utf-8').read()
lines = src.split('\n')

def show(lineno, span=90):
    ln = lines[lineno - 1]
    # find backticks in the line and show neighbourhood with explicit codes
    for m in re.finditer('`', ln):
        s = max(0, m.start() - 6)
        seg = ln[s:m.start() + 3]
        codes = ' '.join(f"{ord(c):02x}" for c in seg)
        print(f"  line {lineno} @col{m.start()+1}: {seg!r}")
        print(f"      codes: {codes}")

for L in (17565, 20657, 28549, 30580):
    print(f"--- line {L} ---")
    show(L)
    print("   raw:", repr(lines[L - 1][:160]))

# count patterns safely
print()
print("double-escape (\\\\\\\\ + backtick) count:", len(re.findall(re.escape('\\\\') + '`', src)))
print("single-escape (\\\\ + backtick) count  :", len(re.findall(re.escape('\\') + '`', src)))
