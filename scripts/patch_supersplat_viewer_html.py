#!/usr/bin/env python3

import re
import sys
from pathlib import Path


if len(sys.argv) != 2:
    raise SystemExit("usage: patch_supersplat_viewer_html.py /path/to/index.html")

target_path = Path(sys.argv[1]).resolve()
original = target_path.read_text(encoding="utf-8")
patched = original.replace(
    '<script type="module">',
    '<script data-cfasync="false" type="module">',
)
patched = re.sub(
    r"(import \{ main \} from '\./index\.js)(?:\?[^']*)?(';)",
    r"\1?v=20260719-first-frame-loader-1\2",
    patched,
    count=1,
)

if "const launchViewer = async () => {" not in patched:
    startup_pattern = re.compile(
        r"(?m)^([ \t]*)document\.addEventListener\('DOMContentLoaded', async \(\) => \{\n"
        r"(.*?)^\1\}\);",
        re.DOTALL,
    )
    match = startup_pattern.search(patched)
    if not match:
        raise RuntimeError("SuperSplat DOMContentLoaded startup block not found")

    indent, body = match.groups()
    body = body[:-1] if body.endswith("\n") else body
    replacement = "\n".join(
        [
            f"{indent}const launchViewer = async () => {{",
            body,
            f"{indent}}};",
            f"{indent}if (document.readyState === 'loading') {{",
            f"{indent}    document.addEventListener('DOMContentLoaded', launchViewer, {{ once: true }});",
            f"{indent}}} else {{",
            f"{indent}    launchViewer();",
            f"{indent}}}",
        ]
    )
    patched = startup_pattern.sub(replacement, patched, count=1)

protected_module_count = patched.count(
    '<script data-cfasync="false" type="module">'
)
if protected_module_count < 2:
    raise RuntimeError(
        f"expected at least two protected module scripts, found {protected_module_count}"
    )
if "./index.js?v=20260719-first-frame-loader-1" not in patched:
    raise RuntimeError("SuperSplat Viewer JS cache version was not patched")

if patched != original:
    target_path.write_text(patched, encoding="utf-8")

print(
    f"patched {target_path}: startup=readyState-safe "
    f"protected_modules={protected_module_count} js_cache=first-frame-loader-1"
)
