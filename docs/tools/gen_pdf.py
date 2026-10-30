#!/usr/bin/env python3
"""Render the committed PDFs -- Markdown docs with code lines that WRAP, plus ad-hoc decks.

Part of the tech-doc kit (~/.claude/skills/tech-doc). Copy it into the project as
`docs/tools/gen_pdf.py` (in MOCA it lives in docs/tools/, two levels below the repo root), then list the
project's docs in PAIRS. Same engine everywhere -- headless Chrome, so the committed PDFs are
Skia-produced -- with the styling checked in, so two people regenerating the same source get
the same file. Replaces the manual "preview in VS Code, print from the browser" flow.

    python3 docs/tools/gen_pdf.py                      # every pair in PAIRS below
    python3 docs/tools/gen_pdf.py deploy/sbx/template-onboarding/GUIDE.md
    python3 docs/tools/gen_pdf.py docs/foo.md -o /tmp/foo.pdf

Two pipelines, picked by extension:
  .md   -> pandoc (GFM -> HTML5, with highlighting) -> our CSS -> Chrome --print-to-pdf
  .pptx -> LibreOffice --convert-to pdf  (an ad-hoc deck only: a deck built by a tech-deck
           generator writes its own PDF in the same run as its .pptx)

THE POINT OF THE CSS: a long shell command must never be clipped at the page edge. Three
rules do that, and they are the reason this file exists rather than a one-line pandoc call:

  1. `pre { white-space: pre-wrap }`   -- wrap instead of overflowing.
  2. a hanging indent per LOGICAL line -- pandoc wraps each source line in its own
     `<span id="cbN-M">`, so continuation rows sit indented under their own line and you
     can still see where one command ends and the next begins. Without this, a wrapped
     `export FOO=...` is indistinguishable from two separate commands, which is exactly
     how the old browser-printed PDFs read.
  3. `overflow-wrap: anywhere` on code and table cells -- URLs and flag soup have no
     spaces to break at, so without this the browser refuses to wrap them at all.

Requires: pandoc and Google Chrome (for .md), LibreOffice (for .pptx). All external
binaries; there is no Python dependency, so this runs from a bare checkout. A tool is only
looked for if a source needs it.
"""

from __future__ import annotations

import argparse
import base64
import html
import mimetypes
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

REPO = pathlib.Path(__file__).resolve().parents[2]  # docs/tools/ -> the repo root

# EDIT PER PROJECT: the docs that ship a committed PDF beside their .md. Add a pair here and it
# is picked up by a bare `python3 docs/tools/gen_pdf.py`. Paths are relative to the repo root.
PAIRS = [
    ("deploy/sbx/template-onboarding/GUIDE.md", "deploy/sbx/template-onboarding/GUIDE.pdf"),
]

SOFFICE_CANDIDATES = ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]

# Repo-relative links in the .md (e.g. `../src/pkg/module.py`) have no meaning in a PDF, so they
# are rewritten to "<GitHub blob base>/<path>". The base is derived from the repo's `origin`
# remote and default branch `main`; set DOC_GITHUB_BLOB to override (or to "" to leave relative
# links untouched, e.g. for a repo with no GitHub remote). See absolutize_repo_links().
def _github_blob() -> str | None:
    env = os.environ.get("DOC_GITHUB_BLOB")
    if env is not None:
        return env.rstrip("/") or None
    try:
        url = subprocess.run(["git", "-C", str(REPO), "remote", "get-url", "origin"],
                             check=True, capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    m = re.match(r"^(?:git@github\.com:|https://github\.com/)([^/]+/[^/]+?)(?:\.git)?$", url)
    return f"https://github.com/{m.group(1)}/blob/main" if m else None


GITHUB_BLOB = _github_blob()

# A table cell longer than this is allowed to break mid-word (`.wrapany`). Below it, the
# cell keeps its natural min-content width so narrow columns stay narrow.
WIDE_CELL_CHARS = 60

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]

CSS = r"""
@page { size: A4; margin: 16mm 14mm 16mm 14mm; }

html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

body {
  font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  font-size: 10.5pt; line-height: 1.55; color: #1f2328;
  margin: 0; padding: 0;
}

/* ---- headings ------------------------------------------------------------ */
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 .5em; font-weight: 600;
                         break-after: avoid; -webkit-column-break-after: avoid; }
h1 { font-size: 20pt; padding-bottom: .25em; border-bottom: 1px solid #d1d9e0; }
h2 { font-size: 15pt; padding-bottom: .25em; border-bottom: 1px solid #d1d9e0; }
h3 { font-size: 12.5pt; }
h4 { font-size: 11pt; }
h1:first-of-type { margin-top: 0; }

p, ul, ol, table, pre, blockquote { margin: 0 0 .8em; }
li { margin: .15em 0; }
li > p { margin: .3em 0; }
a { color: #0969da; text-decoration: none; }

hr { border: 0; border-top: 1px solid #d1d9e0; margin: 1.4em 0; }

blockquote {
  margin-left: 0; padding: .1em 0 .1em 1em;
  border-left: .25em solid #d1d9e0; color: #59636e;
}
blockquote > :last-child { margin-bottom: 0; }

/* ---- code: the wrapping rules ------------------------------------------- */
code, kbd, samp, pre {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}

/* inline code */
:not(pre) > code {
  font-size: .875em; padding: .15em .35em; border-radius: 5px;
  background: #eff1f3; overflow-wrap: anywhere;
}

pre {
  font-size: 8.6pt; line-height: 1.45;
  padding: .7em .85em; border-radius: 6px;
  background: #f6f8fa; border: 1px solid #d1d9e0;
  /* (1) wrap rather than clip at the page edge */
  white-space: pre-wrap;
  /* (3) break inside unbroken URLs / flag soup, which have nowhere else to break */
  overflow-wrap: anywhere; word-break: break-word;
  break-inside: auto;
}
pre > code { padding: 0; background: none; border: 0; font-size: inherit;
             white-space: inherit; overflow-wrap: inherit; }

/* (2) hanging indent per LOGICAL source line.
   pandoc emits one <span id="cbN-M"> per line for highlighted blocks; gen_pdf.py adds
   <span class="cl"> for unhighlighted ones. Either way each logical line is a block, so a
   wrapped continuation is visibly indented under its own line instead of looking like a
   new command. */
pre > code > span[id^="cb"], pre > code > span.cl {
  display: block; padding-left: 3.2ch; text-indent: -3.2ch;
}
/* An ASCII diagram drawn with U+2500 box-drawing glyphs only TILES at a line height of ~1:
   Menlo's box glyphs reach a little past the em box but nowhere near the 1.45 used for code, so
   at that spacing every vertical rule breaks into dashes and the corners pull apart -- the boxes
   stop reading as boxes. gen_pdf.py tags these blocks automatically (see tag_diagrams), so a
   diagram never forces a line-height change on real code. Verify by RENDERING: the XML and the
   extracted text both look perfect either way. */
pre.diagram { line-height: 1.0; }
pre.diagram > code > span.cl { padding-left: 0; text-indent: 0; }

/* a blank line must still occupy a row */
pre > code > span[id^="cb"]:empty::after,
pre > code > span.cl:empty::after { content: "\200b"; }
/* pandoc's per-line anchors are decorative; keep them from adding width */
pre > code > span[id^="cb"] > a:first-child { display: none; }

/* skylighting token colours (GitHub-light-ish), trimmed to what our docs use */
code span.kw { color: #cf222e; }                    /* keyword */
code span.cf { color: #cf222e; }                    /* control flow */
code span.bu, code span.ex { color: #8250df; }      /* builtin / external cmd */
code span.st { color: #0a3069; }                    /* string */
code span.va { color: #953800; }                    /* variable */
code span.dv, code span.dt { color: #0550ae; }      /* value / datatype */
code span.at { color: #0550ae; }                    /* attribute (long flags) */
code span.op { color: #0550ae; }                    /* operator */
code span.co { color: #59636e; font-style: italic; }/* comment */
code span.fu { color: #8250df; }                    /* function */
code span.er, code span.al { color: #cf222e; }      /* error / alert */

/* ---- tables: same problem, same fix ------------------------------------- */
table {
  border-collapse: collapse; width: 100%;
  table-layout: auto; font-size: 9pt;
}
th, td {
  border: 1px solid #d1d9e0; padding: .35em .5em; text-align: left;
  vertical-align: top;
  /* Break inside over-long words, but only at a *line* level: `overflow-wrap: break-word`
     leaves a column's min-content width alone. NOT `anywhere` and NOT
     `word-break: break-word` (Chrome implements that as `anywhere`) -- either one shrinks
     min-content to a single character, and the auto table layout then squeezes the "#"
     column until "11" stacks as 1/1 and the "Code" header splits into "Cod/e". */
  overflow-wrap: break-word;
}
/* Cells that really are long -- the §6.5 commands run to 190 chars with no spaces late in
   the string -- opt in to breaking anywhere. gen_pdf.py tags them by measured text length,
   so short cells never pay the min-content cost above. */
th.wrapany, td.wrapany { overflow-wrap: anywhere; }
th { background: #f6f8fa; font-weight: 600; }
/* keep a row intact across a page break where possible */
tr { break-inside: avoid; }
thead { display: table-header-group; }
table code { background: none; padding: 0; font-size: .95em; }

/* Generated figures (docs/img/*.png). A chart and the take-away paragraph under it must not be
   split across a page break, so the <p> that follows an image is glued to it. */
img { max-width: 100%; display: block; margin: 6px 0 2px; }
p:has(> img) { break-inside: avoid; break-after: avoid; margin-bottom: 2px; }
p:has(> img) + p { break-before: avoid; }
sub { font-size: 8.5pt; color: #57606a; }
"""

HTML_SHELL = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>{title}</title>
<style>{css}</style>
</head><body>
{body}
</body></html>
"""


def outline_titles(pdf: pathlib.Path) -> list[tuple[int, str]]:
    """Walk the PDF outline tree; return [(depth, title), ...] in document order.

    Both engines we use write the outline as plain (uncompressed) objects, so a small
    stdlib reader is enough and gen_pdf.py keeps its no-Python-dependency property. If the
    structure is not recognisable we return [] and the caller warns -- this is a
    verification aid, never a reason to fail a render that otherwise succeeded.
    """
    blob = pdf.read_bytes()
    objs = {int(m.group(1)): m.group(2)
            for m in re.finditer(rb"(\d+)\s+0\s+obj(.*?)endobj", blob, re.S)}
    # Chrome tags the root `/Type /Outlines`; LibreOffice omits /Type entirely, so fall back
    # to whatever the document Catalog points its /Outlines key at. Checking only for
    # /Type /Outlines reports a perfectly good LibreOffice outline as missing.
    root = next((n for n, o in objs.items()
                 if re.search(rb"/Type\s*/Outlines", o)), None)
    if root is None:
        m = re.search(rb"/Outlines\s+(\d+)\s+0\s+R", blob)
        root = int(m.group(1)) if m else None
    if root is None or root not in objs:
        return []

    def ref(obj: bytes, key: bytes) -> int | None:
        m = re.search(rb"/" + key + rb"\s+(\d+)\s+0\s+R", obj)
        return int(m.group(1)) if m else None

    def title(obj: bytes) -> str:
        m = re.search(rb"/Title\s*", obj)
        if not m:
            return "?"
        i = m.end()
        if blob and obj[i:i + 1] == b"<":                      # UTF-16BE hex string
            j = obj.index(b">", i)
            raw = bytes.fromhex(re.sub(rb"\s", b"", obj[i + 1:j]).decode())
            return raw.decode("utf-16-be", errors="replace").lstrip("﻿")
        if obj[i:i + 1] != b"(":
            return "?"
        # Literal string: honour \( \) escapes and nesting, or titles containing a
        # parenthesis come out truncated.
        i, depth, out = i + 1, 1, bytearray()
        while depth and i < len(obj):
            c = obj[i:i + 1]
            if c == b"\\":
                out += {b"n": b"\n", b"r": b"\r", b"t": b"\t"}.get(obj[i + 1:i + 2],
                                                                  obj[i + 1:i + 2])
                i += 2
                continue
            if c == b"(":
                depth += 1
            elif c == b")":
                depth -= 1
                if not depth:
                    break
            out += c
            i += 1
        return out.decode("utf-8", errors="replace")

    found: list[tuple[int, str]] = []
    seen: set[int] = set()

    def walk(n: int | None, depth: int = 0) -> None:
        while n is not None and n in objs and n not in seen:
            seen.add(n)
            found.append((depth, title(objs[n])))
            walk(ref(objs[n], b"First"), depth + 1)
            n = ref(objs[n], b"Next")

    walk(ref(objs[root], b"First"))
    return found


def report_outline(pdf: pathlib.Path) -> None:
    entries = outline_titles(pdf)
    if not entries:
        print(f"  WARNING: {pdf.name} has NO PDF outline (bookmarks) -- viewers will show "
              f"no navigation sidebar", file=sys.stderr)
        return
    depths = sorted({d for d, _ in entries})
    print(f"  outline: {len(entries)} bookmarks, depth {min(depths)}-{max(depths)}, "
          f"first={entries[0][1][:40]!r}")


def find_chrome() -> str:
    for c in CHROME_CANDIDATES:
        if pathlib.Path(c).is_file():
            return c
    for n in ("chromium", "google-chrome", "google-chrome-stable"):
        p = shutil.which(n)
        if p:
            return p
    sys.exit("no Chrome/Chromium found; install Google Chrome or set one of "
             + ", ".join(CHROME_CANDIDATES))


def find_soffice() -> str:
    for c in SOFFICE_CANDIDATES:
        if pathlib.Path(c).is_file():
            return c
    for n in ("soffice", "libreoffice"):
        p = shutil.which(n)
        if p:
            return p
    sys.exit("no LibreOffice found (needed for .pptx); install it or drop the pptx pair")


def render_pptx(src: pathlib.Path, pdf_path: pathlib.Path, soffice: str,
                timeout: int = 300) -> None:
    """Slides -> PDF via LibreOffice. It insists on naming the output itself (<stem>.pdf in
    --outdir), so convert into a temp dir and move the result to the path we were asked for."""
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        subprocess.run([soffice, "--headless", f"-env:UserInstallation={(tmp / 'profile').as_uri()}",
                        "--convert-to", "pdf", "--outdir", str(tmp), str(src)],
                       check=True, capture_output=True, text=True, timeout=timeout)
        produced = tmp / (src.stem + ".pdf")
        if not produced.is_file():
            sys.exit(f"libreoffice produced no PDF for {src}")
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(produced), str(pdf_path))
    print(f"{src} -> {pdf_path}  ({pdf_path.stat().st_size:,} bytes)")
    report_outline(pdf_path)


def absolutize_repo_links(html_body: str, md: pathlib.Path) -> str:
    """Point repo-relative links at GitHub instead of at the renderer's temp directory.

    We render from a throwaway HTML file in /tmp, so a link like `../src/pkg/app.py`
    resolves against THAT directory: the committed PDF ended up carrying
    `file:///var/folders/.../tmpXXXX/src/pkg/app.py` links, which are dead for every
    reader and leak the build machine's temp path into a published artifact. In-page anchors
    (`#section`) and absolute URLs are already correct and are left alone.
    """
    def fix(m: re.Match) -> str:
        href = html.unescape(m.group(1))
        if GITHUB_BLOB is None or re.match(r"^(#|[a-zA-Z][a-zA-Z0-9+.-]*:|//)", href):
            return m.group(0)
        path, _, frag = href.partition("#")
        try:
            target = (md.parent / path).resolve().relative_to(REPO)
        except ValueError:                       # outside the repo; nothing better to offer
            return m.group(0)
        url = f"{GITHUB_BLOB}/{target.as_posix()}" + (f"#{frag}" if frag else "")
        return f'href="{html.escape(url)}"'

    return re.sub(r'href="([^"]*)"', fix, html_body)


def inline_images(html_body: str, md: pathlib.Path) -> str:
    """Embed each local `<img src>` as a data URI.

    Same root cause as absolutize_repo_links(), but a worse failure: we render from a throwaway
    directory in /tmp, so a relative `src` like `img/leg-pareto.png` resolves to a file that is
    not there and the figure comes out as an empty box -- SILENTLY, because Chrome's
    --print-to-pdf exits 0 either way. Pointing the src at the source tree instead would make
    the committed PDF depend on the build machine's paths, and pointing it at GitHub would make
    it depend on the network at print time. Embedding is the only option that survives both.

    A missing file is fatal rather than skipped: a doc that cites a figure it cannot show is
    exactly the drift the generated-docs rule exists to prevent.
    """
    def fix(m: re.Match) -> str:
        src = html.unescape(m.group(1))
        if re.match(r"^(data:|[a-zA-Z][a-zA-Z0-9+.-]*:|//)", src):
            return m.group(0)
        path = (md.parent / src.partition("#")[0]).resolve()
        if not path.is_file():
            raise SystemExit(f"{md}: image not found: {src}\n"
                             f"  (regenerate the figure with the generator the doc names for it)")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        b64 = base64.b64encode(path.read_bytes()).decode("ascii")
        return f'src="data:{mime};base64,{b64}"'

    return re.sub(r'src="([^"]*)"', fix, html_body)


def md_to_html_body(md: pathlib.Path) -> str:
    """GFM -> HTML fragment, highlighted, with per-line spans everywhere."""
    out = subprocess.run(
        ["pandoc", "--from", "gfm", "--to", "html5", "--wrap=preserve", str(md)],
        check=True, capture_output=True, text=True).stdout

    # pandoc separates its per-line spans with a real newline. Under `white-space:
    # pre-wrap` that newline renders as a break IN ADDITION to the span's display:block,
    # which double-spaces every code block. Drop exactly those newlines.
    out = re.sub(r'</span>\n(?=<span id="cb)', "</span>", out)

    # Fenced blocks with no language get no per-line spans from pandoc, so add them --
    # otherwise those blocks lose the hanging indent and wrap ambiguously.
    def add_line_spans(m: re.Match) -> str:
        open_tag, body = m.group(1), m.group(2)
        if "<span" in body:                       # already highlighted; leave alone
            return m.group(0)
        lines = body.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        return open_tag + "".join(f'<span class="cl">{l}</span>' for l in lines) + "</code></pre>"

    out = re.sub(r'(<pre[^>]*><code[^>]*>)(.*?)</code></pre>', add_line_spans, out,
                 flags=re.S)

    # Tag code blocks that draw a picture, so the CSS can tighten their line height without
    # touching any other block (see the `pre.diagram` rule). Detection is the box-drawing range
    # itself -- a block either contains those glyphs, in which case it is a diagram, or it does
    # not and nothing changes.
    def tag_diagrams(m: re.Match) -> str:
        open_tag, body = m.group(1), m.group(2)
        if not re.search(r"[─-╿]", body):
            return m.group(0)
        pre, rest = open_tag.split(">", 1)
        if 'class="' in pre:
            pre = pre.replace('class="', 'class="diagram ', 1)
        else:
            pre += ' class="diagram"'
        return f"{pre}>{rest}{body}</code></pre>"

    out = re.sub(r'(<pre[^>]*><code[^>]*>)(.*?)</code></pre>', tag_diagrams, out, flags=re.S)

    # Tag long table cells so the CSS can let them break mid-word without narrowing every
    # other column (see the `.wrapany` rule).
    def tag_wide_cell(m: re.Match) -> str:
        tag, attrs, inner = m.group(1), m.group(2), m.group(3)
        text = html.unescape(re.sub(r"<[^>]+>", "", inner))
        if len(text.strip()) <= WIDE_CELL_CHARS:
            return m.group(0)
        if 'class="' in attrs:
            attrs = attrs.replace('class="', 'class="wrapany ', 1)
        else:
            attrs += ' class="wrapany"'
        return f"<{tag}{attrs}>{inner}</{tag}>"

    out = re.sub(r"<(t[dh])((?:\s[^>]*)?)>(.*?)</\1>", tag_wide_cell, out, flags=re.S)
    out = absolutize_repo_links(out, md)
    out = inline_images(out, md)
    return out


def render(md_path: pathlib.Path, pdf_path: pathlib.Path, chrome: str,
           timeout: int = 90) -> None:
    body = md_to_html_body(md_path)
    title = md_path.stem
    doc = HTML_SHELL.format(title=html.escape(title), css=CSS, body=body)

    # `ignore_cleanup_errors` because Chrome's helper processes (zygote, renderers, network
    # service) are not our child -- killing the one we launched does not stop them writing to
    # `profile/`, so the rmtree below used to race them and raise `Directory not empty`. That
    # exception escaped `main()` and killed the whole batch, so any pair after the crash was
    # left silently unregenerated while the PDFs before it were fresh. Starting a new session (below) makes the group kill reliable;
    # this is the belt to that braces, since a leftover temp profile harms nothing.
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
        tmp = pathlib.Path(td)
        html_file = tmp / f"{title}.html"
        html_file.write_text(doc, encoding="utf-8")
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            chrome,
            "--headless=new",
            "--disable-gpu",
            # never touch the user's real Chrome profile
            f"--user-data-dir={tmp / 'profile'}",
            "--no-first-run", "--no-default-browser-check",
            "--no-pdf-header-footer",
            # PDF outline (the viewer's bookmarks sidebar) built from the h1-h6 tree, so a
            # 60-page guide is navigable. Chrome emits NO outline without this -- the flag
            # is the command-line face of CDP's Page.printToPDF generateDocumentOutline,
            # and it needs Chrome >= 122. Older builds ignore an unknown switch silently
            # rather than failing, and verify_outline() below catches that.
            "--generate-pdf-document-outline",
            "--run-all-compositor-stages-before-draw",
            "--virtual-time-budget=20000",
            f"--print-to-pdf={pdf_path}",
            html_file.as_uri(),
        ]
        before = pdf_path.stat().st_mtime_ns if pdf_path.is_file() else -1
        # Headless Chrome writes the PDF in a few seconds and then does NOT exit -- waiting
        # on the process turns a 6-second render into a 90-second one. So watch the artifact
        # instead: as soon as it is rewritten and its size has stopped growing, we have what
        # we came for and Chrome can be killed.
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                start_new_session=True)
        deadline, last_size, done = time.monotonic() + timeout, None, False
        while time.monotonic() < deadline:
            if proc.poll() is not None:          # exited on its own; artifact is final
                done = True
                break
            st = pdf_path.stat() if pdf_path.is_file() else None
            if st and st.st_mtime_ns != before:
                if st.st_size == last_size and st.st_size > 0:
                    done = True
                    break
                last_size = st.st_size
            time.sleep(0.3)
        if proc.poll() is None:
            # Kill the whole group, not just the launcher: Chrome's helpers survive a plain
            # kill() and keep the temp profile busy (and, on a long batch, keep running).
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()
        proc.wait()
        if not done or not pdf_path.is_file() or pdf_path.stat().st_mtime_ns == before:
            sys.exit(f"chrome produced no PDF for {md_path} within {timeout}s")
    size = pdf_path.stat().st_size
    print(f"{md_path} -> {pdf_path}  ({size:,} bytes)")
    report_outline(pdf_path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sources", nargs="*",
                    help="markdown files; default is every pair listed in PAIRS")
    ap.add_argument("-o", "--output", help="output PDF (only with a single source)")
    ap.add_argument("--timeout", type=int, default=90,
                    help="seconds to wait for Chrome before killing it (default 90)")
    a = ap.parse_args()

    if a.sources:
        if a.output and len(a.sources) > 1:
            sys.exit("--output takes a single source")
        jobs = [(pathlib.Path(s), pathlib.Path(a.output) if a.output
                 else pathlib.Path(s).with_suffix(".pdf")) for s in a.sources]
    else:
        jobs = [(REPO / m, REPO / p) for m, p in PAIRS]

    for src, pdf in jobs:
        if not src.is_file():
            sys.exit(f"missing source: {src}")

    # Resolve each toolchain only if something in this batch needs it, so a machine without
    # LibreOffice can still regenerate the markdown PDFs and vice versa.
    slides = [j for j in jobs if j[0].suffix.lower() == ".pptx"]
    docs = [j for j in jobs if j[0].suffix.lower() != ".pptx"]
    if docs:
        if not shutil.which("pandoc"):
            sys.exit("pandoc not found; brew install pandoc")
        chrome = find_chrome()
        for md, pdf in docs:
            render(md, pdf, chrome, a.timeout)
    if slides:
        soffice = find_soffice()
        for src, pdf in slides:
            render_pptx(src, pdf, soffice)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
