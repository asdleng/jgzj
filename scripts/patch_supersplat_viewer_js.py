#!/usr/bin/env python3

import sys
from pathlib import Path


if len(sys.argv) != 2:
    raise SystemExit("usage: patch_supersplat_viewer_js.py /path/to/index.js")

target_path = Path(sys.argv[1]).resolve()
original = target_path.read_text(encoding="utf-8")
old_block = """    // Hide loading bar once loaded
    events.on('loaded:changed', () => {
        document.getElementById('loadingWrap').classList.add('hidden');
    });"""
new_block = """    // Keep the progress indicator visible until the first sorted splat frame is rendered.
    events.on('loaded:changed', () => {
        if (dom.loadingText.textContent === '100%') {
            dom.loadingText.textContent = '100% - preparing first frame';
        }
    });
    events.on('firstFrame', () => {
        document.getElementById('loadingWrap').classList.add('hidden');
    });"""

if new_block in original:
    patched = original
elif old_block in original:
    patched = original.replace(old_block, new_block, 1)
else:
    raise RuntimeError("SuperSplat loading completion block not found")

if patched.count("events.on('firstFrame', () => {") < 2:
    raise RuntimeError("first-frame loading handler was not installed")
if "100% - preparing first frame" not in patched:
    raise RuntimeError("first-frame progress label was not installed")

if patched != original:
    target_path.write_text(patched, encoding="utf-8")

print(f"patched {target_path}: loading_hide=firstFrame")
