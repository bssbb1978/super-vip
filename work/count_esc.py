#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import re, sys

PATH = '/home/user/uploads/index1.js'
src = open(PATH, encoding='utf-8').read()

patterns = {
    'double-backslash + backtick': r'\\\\`',
    'backslash + backtick      ': r'\\`',
    'backslash + ${            ': r'\\\$\{',
}
for name, pat in patterns.items():
    ms = list(re.finditer(pat, src))
    print(f"{name}: {len(ms)}")
    for m in ms[:6]:
        line = src[:m.start()].count('\n') + 1
        print('     line', line, '|', repr(src[max(0, m.start() - 60):m.start() + 45]))
