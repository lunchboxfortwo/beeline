"""PEOPLE-1 Android capture: open the harness APK, screenshot Bone and Obsidian,
and report each tab label's height in lines from UIAutomator bounds.

Usage: python3 capture-android.py --adb "adb -H 127.0.0.1 -P 5037 -s emulator-5646" --out DIR
Exits 1 when any label in a "pr" bar wraps to a second line.
"""
import argparse
import re
import shlex
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

PACKAGE = 'work.beeline.proof.people1'
LABELS = ['Chats', 'Tags', 'People', 'Settings']
META_LINE_DP = 19  # grammar.tsx TYPE_SCALE.meta.line at text scale 1

parser = argparse.ArgumentParser()
parser.add_argument('--adb', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)


def adb(*parts):
    return subprocess.check_output([*shlex.split(args.adb), *parts])


def bounds(node):
    left, top, right, bottom = map(int, re.findall(r'\d+', node.get('bounds')))
    return left, top, right, bottom


def dump():
    adb('shell', 'uiautomator', 'dump', '/sdcard/people-1.xml')
    return list(ET.fromstring(adb('shell', 'cat', '/sdcard/people-1.xml')).iter('node'))


def measure(theme, density, seen):
    """React Native flattens the tab views, so a label belongs to the bar whose bounds hold it."""
    nodes = dump()
    bars = [n for n in nodes if (n.get('resource-id') or '').startswith('bar-')]
    texts = [n for n in nodes if n.get('text') in LABELS]
    failed = False
    for bar in sorted(bars, key=lambda n: bounds(n)[1]):
        name = bar.get('resource-id')
        _, bar_top, _, bar_bottom = bounds(bar)
        if name in seen or bar_bottom > screen_bottom:
            continue  # partly off screen; measured after the scroll
        seen.add(name)
        side, scale = name.split('-')[1], float(name.split('-')[2])
        line_px = META_LINE_DP * scale * density
        notes = []
        for label in LABELS:
            text = next((n for n in texts if n.get('text') == label and bar_top <= bounds(n)[1] < bar_bottom), None)
            if text is None:
                notes.append(f'{label}(missing)')
                continue
            _, top, _, bottom = bounds(text)
            lines = round((bottom - top) / line_px)
            if lines > 1:
                notes.append(f'{label}({lines} lines)')
        if notes and side == 'pr':
            failed = True
        print(f'{theme} {name}: ' + (('WRONG ' + ' '.join(notes)) if notes else 'every label on one line'))
    return failed


density = int(re.search(rb'(\d+)', adb('shell', 'wm', 'density')).group(1)) / 160
font_scale = adb('shell', 'settings', 'get', 'system', 'font_scale').decode().strip()
print(f'system font_scale {font_scale}, density {density * 160:.0f}dpi')
adb('shell', 'am', 'force-stop', PACKAGE)
adb('shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1')
time.sleep(6)
screen_bottom = int(re.findall(rb'(\d+)x(\d+)', adb('shell', 'wm', 'size'))[-1][1])
failed = False
for theme in ['bone', 'obsidian']:
    seen = set()
    failed |= measure(theme, density, seen)
    (out / f'android-{theme}-top.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    adb('shell', 'input', 'swipe', '540', '1900', '540', '400', '400')
    time.sleep(1)
    failed |= measure(theme, density, seen)
    (out / f'android-{theme}-bottom.png').write_bytes(adb('exec-out', 'screencap', '-p'))
    adb('shell', 'input', 'swipe', '540', '400', '540', '2200', '300')
    adb('shell', 'input', 'swipe', '540', '400', '540', '2200', '300')
    time.sleep(1)
    toggle = next(n for n in dump() if n.get('resource-id') == 'toggle-theme')
    left, top, right, bottom = bounds(toggle)
    adb('shell', 'input', 'tap', str((left + right) // 2), str((top + bottom) // 2))
    time.sleep(1.5)
adb('shell', 'am', 'force-stop', PACKAGE)
raise SystemExit(1 if failed else 0)
