#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Map intended template-literal regions: openers (line ends with `= \``) and
closers (line is only a backtick, optionally followed by ; ) , )."""
import re, sys

path = sys.argv[1] if len(sys.argv) > 1 else 'segs/seg9.js'
src = open(path, encoding='utf-8').read()
lines = src.split('\n')

OPEN = re.compile(r"=\s*`\s*$")
CLOSE = re.compile(r"^\s*`\s*[;,)`]?\s*$")

print("OPENERS (assignment templates):")
for i, l in enumerate(lines, 1):
    if OPEN.search(l):
        print(f"  {i:6} | {l.strip()[:100]}")

print("\nCLOSERS (lone backtick lines):")
for i, l in enumerate(lines, 1):
    if CLOSE.match(l):
        print(f"  {i:6} | {l.strip()[:60]}")
