"""deck_kit -- native-shape slide decks from one Python script, with a PDF from the same build.

Copy this file next to a deck's generator (it is deliberately one file with no package), import
it, and write one function per slide. See SKILL.md beside it for the rules this encodes.

    from deck_kit import *
    d = Deck("My title", footer="project · deck")
    ...
    d.build(SECTIONS, title_slide=my_title)          # .pptx, then .pdf beside it

Requires python-pptx and pypdf (requirements.txt beside this file pins both).
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

__all__ = [
    "Deck", "text", "box", "arrow", "label", "table", "bar_chart",
    "brain", "hands", "store", "queue", "orchestrator", "note",
    "INK", "MUTED", "WHITE", "RULE", "WARN", "ACCENT", "NEUTRAL", "INFRA", "NOTE",
    "W", "H", "MIN_PT", "MSO_ANCHOR", "PP_ALIGN", "MSO_SHAPE", "RGBColor", "Inches", "Pt",
]

FONT = "Arial"           # sans-serif, present on every renderer
CODE = "Consolas"        # inline identifiers only; LibreOffice substitutes DejaVu Sans Mono

# ------------------------------------------------------------------ the palette: learned once
# Text and chrome.
INK = RGBColor(0x1F, 0x2A, 0x44)
MUTED = RGBColor(0x5B, 0x64, 0x77)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
RULE = RGBColor(0xC9, 0xCF, 0xDA)
# Roles, each a (fill, line) pair. ONE accent, for the brain (the thing doing the thinking:
# agent, harness, controller); ONE neutral, for the hands (sandbox, worker, the thing acted on).
# Infrastructure (state, queue, orchestrator) is outlined, not filled, so it recedes. WARN is
# reserved for a warning and is never a component colour. Override these in one place per deck,
# never per slide.
ACCENT = (RGBColor(0xE4, 0xF1, 0xF6), RGBColor(0x0F, 0x76, 0x8C))   # teal
NEUTRAL = (RGBColor(0xF1, 0xF2, 0xF4), RGBColor(0x6B, 0x72, 0x80))  # slate grey
INFRA = (WHITE, RGBColor(0x8A, 0x93, 0xA3))
WARN = RGBColor(0xB0, 0x3A, 0x2E)
NOTE = (RGBColor(0xFB, 0xEC, 0xEA), WARN)

W, H = Inches(13.333), Inches(7.5)
MIN_PT = 10              # nothing on a slide is set smaller; body text is 12 or more


def _runs(p, s, size, color, bold=False, italic=False):
    """`**bold**` and `` `code` `` inline (code may sit inside bold), nothing else: a slide
    needs two emphases, not a markup language."""
    assert size >= MIN_PT, f"{size}pt is under the {MIN_PT}pt floor: {s[:40]!r}"
    for tok in re.split(r"(\*\*.+?\*\*|`.+?`)", s):
        if not tok:
            continue
        if tok.startswith("**"):
            _runs(p, tok[2:-2], size, color, bold=True, italic=italic)
            continue
        r = p.add_run()
        f = r.font
        f.size, f.color.rgb, f.bold, f.italic = Pt(size), color, bold, italic
        if tok.startswith("`"):
            r.text, f.name = tok[1:-1], CODE
        else:
            r.text, f.name = tok, FONT


def _bullet(p, level, size):
    ppr = p._p.get_or_add_pPr()
    indent = Emu(Pt(size) * 0.9)
    ppr.set("marL", str(int(indent * (level + 1)) + int(Pt(size) * 0.3 * level)))
    ppr.set("indent", str(-int(indent)))
    etree.SubElement(ppr, qn("a:buChar")).set("char", "•" if level == 0 else "–")


def _fill(tf, lines, size, color=INK, align=PP_ALIGN.LEFT, bullets=False, gap=4, bold=False,
          plain_first=False):
    """Lines are strings, or (string, level) for a sub-bullet. A BLANK line is refused: spacing
    comes from `gap` (space after each paragraph), never from an empty paragraph -- which also
    renders as a stray bullet when bullets are on."""
    tf.word_wrap = True
    for i, line in enumerate(lines):
        level = 0
        if isinstance(line, tuple):
            line, level = line
        if not line.strip():
            raise ValueError("a blank line inside a text frame. FIX: drop it and raise `gap`, "
                             "or split the content into two boxes")
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.space_after = Pt(gap)
        sz = size - 2 * level
        _runs(p, line, sz, color if level == 0 or not bullets else MUTED, bold=bold)
        if bullets and not (plain_first and i == 0):
            _bullet(p, level, sz)


def text(s, x, y, w, h, lines, size=16, color=INK, align=PP_ALIGN.LEFT, bullets=False,
         anchor=MSO_ANCHOR.TOP, gap=6, bold=False):
    tb = s.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.margin_left = tf.margin_right = Inches(0.04)
    tf.margin_top = tf.margin_bottom = Inches(0.02)
    tf.vertical_anchor = anchor
    _fill(tf, [lines] if isinstance(lines, str) else lines, size, color, align, bullets, gap,
          bold)
    return tb


def box(s, x, y, w, h, pal, title=None, body=(), size=12, title_size=None, shape=None,
        align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE, line_w=1.25, dash=False, bullets=False,
        gap=2):
    """A filled shape with an optional bold title line and body lines. Size the box to its
    content; do not pad it with blank lines (refused) or leave a tall box half empty."""
    shp = s.shapes.add_shape(shape or MSO_SHAPE.ROUNDED_RECTANGLE,
                             Inches(x), Inches(y), Inches(w), Inches(h))
    if shp.adjustments and (shape is None or shape == MSO_SHAPE.ROUNDED_RECTANGLE):
        shp.adjustments[0] = min(0.12, 0.08 / max(min(w, h), 0.5) * 2)
    shp.shadow.inherit = False          # no theme shadow: flat, no 3D
    shp.fill.solid()
    shp.fill.fore_color.rgb = pal[0]
    shp.line.color.rgb = pal[1]
    shp.line.width = Pt(line_w)
    if dash:
        shp.line.dash_style = 4         # MSO_LINE.DASH
    tf = shp.text_frame
    tf.margin_left = tf.margin_right = Inches(0.08)
    tf.margin_top = tf.margin_bottom = Inches(0.04)
    tf.vertical_anchor = anchor
    lines = ([f"**{title}**"] if title else []) + list(body)
    if lines:
        _fill(tf, lines, size, INK, align, bullets=bullets, gap=gap, plain_first=bool(title))
        if title and title_size:
            for r in tf.paragraphs[0].runs:
                r.font.size = Pt(title_size)
    return shp


# ---------------------------------------------- the iconography: one shape per recurring part
# Every architecture slide draws a component with ITS function, so the same thing always has the
# same shape and colour. Add a function here for a new recurring component; never draw one ad hoc.

def brain(s, x, y, w, h, title, body=(), **kw):
    """The agent / harness / controller: accent, rounded, solid."""
    return box(s, x, y, w, h, ACCENT, title, body, **kw)


def hands(s, x, y, w, h, title, body=(), **kw):
    """The sandbox / worker / VM: neutral, rounded, solid."""
    return box(s, x, y, w, h, NEUTRAL, title, body, **kw)


def store(s, x, y, w, h, title, body=(), **kw):
    """State (Redis, a database, a bucket): a flat cylinder."""
    return box(s, x, y, w, h, INFRA, title, body, shape=MSO_SHAPE.CAN, **kw)


def queue(s, x, y, w, h, title, body=(), **kw):
    """A queue or stream: a rectangle with three slots at its outlet end."""
    shp = box(s, x, y, w, h, INFRA, title, body, shape=MSO_SHAPE.RECTANGLE, **kw)
    for k in range(3):
        sx = x + w - 0.12 - k * 0.12
        arrow(s, sx, y + 0.06, sx, y + h - 0.06, color=INFRA[1], w=1, head=False)
    return shp


def orchestrator(s, x, y, w, h, title, body=(), **kw):
    """A scheduler / control plane / orchestrator: a hexagon."""
    return box(s, x, y, w, h, INFRA, title, body, shape=MSO_SHAPE.HEXAGON, **kw)


def note(s, x, y, w, h, title, body=(), **kw):
    """A caveat or warning: the only place WARN fills a shape."""
    kw.setdefault("align", PP_ALIGN.LEFT)
    return box(s, x, y, w, h, NOTE, title, body, **kw)


def arrow(s, x1, y1, x2, y2, color=INK, w=1.5, both=False, dash=False, head=True):
    """A real connector (editable, re-routable in PowerPoint), not a drawn line image."""
    c = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1),
                               Inches(x2), Inches(y2))
    c.line.color.rgb = color
    c.line.width = Pt(w)
    if dash:
        c.line.dash_style = 4
    ln = c.line._get_or_add_ln()
    for end in (["headEnd"] if both else []) + (["tailEnd"] if head else []):
        e = etree.SubElement(ln, qn(f"a:{end}"))
        e.set("type", "triangle")
        e.set("w", "med")
        e.set("len", "med")
    return c


def label(s, x, y, w, h, t, size=11, color=MUTED, align=PP_ALIGN.CENTER, italic=False):
    tb = text(s, x, y, w, h, t if isinstance(t, list) else [t], size=size, color=color,
              align=align, gap=0, anchor=MSO_ANCHOR.MIDDLE)
    if italic:
        for p in tb.text_frame.paragraphs:
            for r in p.runs:
                r.font.italic = True
    return tb


def table(s, x, y, w, rows, widths, size=12, row_h=0.36, right_from=1, header_size=None,
          zebra=True, bold_first_col=False):
    """rows[0] is the header. Columns from `right_from` on are right-aligned (numbers)."""
    nr, nc = len(rows), len(rows[0])
    gt = s.shapes.add_table(nr, nc, Inches(x), Inches(y), Inches(w), Inches(row_h * nr))
    t = gt.table
    tot = sum(widths)
    for j, cw in enumerate(widths):
        t.columns[j].width = Inches(w * cw / tot)
    for i in range(nr):
        t.rows[i].height = Inches(row_h)
        for j in range(nc):
            cell = t.cell(i, j)
            cell.margin_left = cell.margin_right = Inches(0.06)
            cell.margin_top = cell.margin_bottom = Inches(0.02)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.RIGHT if 0 <= right_from <= j else PP_ALIGN.LEFT
            head = i == 0
            _runs(p, str(rows[i][j]), (header_size or size) if head else size,
                  WHITE if head else INK, bold=head or (bold_first_col and j == 0))
            cell.fill.solid()
            cell.fill.fore_color.rgb = (INK if head else RGBColor(0xF3, 0xF5, 0xF9)
                                        if zebra and i % 2 == 0 else WHITE)
    tbl_pr = gt._element.graphic.graphicData.tbl.tblPr
    tbl_pr.set("bandRow", "0")
    tbl_pr.set("firstRow", "0")
    return gt


def bar_chart(s, x, y, w, h, categories, series, colors, stacked=False, horizontal=True,
              number_format="#,##0", labels=True, size=12, gap_width=60):
    """A NATIVE chart (editable data in PowerPoint): flat bars, one value axis, no gridline
    clutter, no 3D. `series` is {name: values}; one series per message, or the parts of ONE total
    when stacked. The slide title states the chart's single message, so the chart has none."""
    assert len(series) == len(colors), "one colour per series"
    assert not (stacked and len(series) < 2), "a stacked chart needs parts"
    cd = CategoryChartData(number_format=number_format)
    cd.categories = categories
    for name, vals in series.items():
        assert len(vals) == len(categories), f"series {name!r}: one value per category"
        cd.add_series(name, vals)
    kind = {(True, True): XL_CHART_TYPE.BAR_STACKED, (True, False): XL_CHART_TYPE.BAR_CLUSTERED,
            (False, True): XL_CHART_TYPE.COLUMN_STACKED,
            (False, False): XL_CHART_TYPE.COLUMN_CLUSTERED}[(horizontal, stacked)]
    gf = s.shapes.add_chart(kind, Inches(x), Inches(y), Inches(w), Inches(h), cd)
    ch = gf.chart
    ch.has_title = False
    ch.font.name, ch.font.size, ch.font.color.rgb = FONT, Pt(size), INK
    ch.has_legend = len(series) > 1
    if ch.has_legend:
        ch.legend.position = XL_LEGEND_POSITION.BOTTOM
        ch.legend.include_in_layout = False
        ch.legend.font.size, ch.legend.font.color.rgb = Pt(size), INK
    plot = ch.plots[0]
    plot.gap_width = gap_width
    if stacked:
        plot.overlap = 100
    for ser, c in zip(plot.series, colors):
        ser.format.fill.solid()
        ser.format.fill.fore_color.rgb = c
        ser.format.line.fill.background()
    va, ca = ch.value_axis, ch.category_axis
    va.has_major_gridlines = True
    va.major_gridlines.format.line.color.rgb = RULE
    va.format.line.fill.background()
    va.tick_labels.font.size = Pt(max(MIN_PT, size - 1))
    va.tick_labels.font.color.rgb = MUTED
    ca.format.line.color.rgb = RULE
    ca.tick_labels.font.size = Pt(size)
    if horizontal:
        # First category at the top, as it is read. Reversing alone moves the value axis to the
        # top too; crossing at the maximum category puts it back at the bottom. That is the VALUE
        # axis's own <c:crosses>, which python-pptx 1.0.2 cannot reach: its category axis has no
        # `crosses`, so assigning one silently sets a plain Python attribute.
        ca.reverse_order = True
        va._element.find(qn("c:crosses")).set("val", "max")
    if labels and not stacked:
        plot.has_data_labels = True
        dl = plot.data_labels
        dl.number_format, dl.number_format_is_linked = number_format, False
        dl.font.size, dl.font.color.rgb = Pt(size), INK
        dl.position = XL_LABEL_POSITION.OUTSIDE_END
    return gf


# --------------------------------------------------------------------------------- the deck

class Deck:
    """One deck. `slide()` adds a content slide with the title bar, kicker, footer and number;
    `build()` walks SECTIONS, draws the outline as slide 2 once every title is known, adds
    PowerPoint's own sections, runs the refusal checks, saves, and renders the PDF."""

    def __init__(self, title, footer, out, refuse=()):
        self.title, self.footer, self.out = title, footer, Path(out)
        # (regex, FIX text) pairs checked over every string written into the file, notes
        # included -- e.g. a dollar figure in a deck that must carry none.
        self.refuse = list(refuse)
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = W, H
        self.blank = self.prs.slide_layouts[6]
        self.n = 0
        self.section = None
        self.index = []          # (section, number, title) per content slide

    def slide(self, title, kicker=None, notes=None, number=None):
        """`notes` holds what the slide paraphrases: the exact command, config or code."""
        s = self.prs.slides.add_slide(self.blank)
        if number is None:
            self.n += 1
            number = self.n
            self.index.append((self.section, number, title))
        where = f"{self.section[0]}  {self.section[1]}" if self.section else "outline"
        bar = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, W, Inches(0.12))
        bar.fill.solid()
        bar.fill.fore_color.rgb = INK
        bar.line.fill.background()
        text(s, 0.45, 0.28, 12.4, 0.62, [title], size=26, bold=True, anchor=MSO_ANCHOR.MIDDLE)
        if kicker:
            text(s, 0.45, 0.86, 12.4, 0.36, [kicker], size=14, color=MUTED)
        rule = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(0.45), Inches(7.05),
                                      Inches(12.88), Inches(7.05))
        rule.line.color.rgb = RULE
        rule.line.width = Pt(0.75)
        label(s, 0.45, 7.1, 9, 0.3, f"{self.footer} · {where}", size=10, align=PP_ALIGN.LEFT)
        label(s, 11.9, 7.1, 1.0, 0.3, str(number), size=10, align=PP_ALIGN.RIGHT)
        if notes:
            s.notes_slide.notes_text_frame.text = notes
        return s

    def title_slide(self, subtitle, byline):
        s = self.prs.slides.add_slide(self.blank)
        self.n += 1
        bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, W, H)
        bg.fill.solid()
        bg.fill.fore_color.rgb = INK
        bg.line.fill.background()
        light = RGBColor(0xC9, 0xD6, 0xEA)
        text(s, 0.8, 2.2, 11.7, 1.2, [self.title], size=40, color=WHITE, bold=True)
        text(s, 0.8, 3.35, 11.7, 1.2, [subtitle], size=22, color=light)
        text(s, 0.8, 5.3, 11.7, 1.0, [byline], size=16, color=light)
        return s

    def outline(self, blurbs):
        """Slide 2: one card per section, listing its slides by number. Up to six sections."""
        # A section numbered "B" holds backup slides: no card, named in the kicker instead.
        backup = [n for sec, n, _ in self.index if sec[0] == "B"]
        main = sum(1 for no in blurbs if no != "B")
        kick = f"{main} sections; the numbers are slide numbers"
        if backup:
            kick += (f"; backup: slide {backup[0]}" if len(backup) == 1
                     else f"; backup: slides {backup[0]}-{backup[-1]}")
        s = self.slide("Outline", kick, number=2)
        secs = []
        for sec, n, t in self.index:
            if sec[0] == "B":
                continue
            if not secs or secs[-1][0] != sec:
                secs.append((sec, []))
            secs[-1][1].append((n, t))
        assert len(secs) <= 6, "more than six sections will not fit the outline: merge some"
        cols = 3 if len(secs) > 4 else 2
        cw = (12.43 - 0.215 * (cols - 1)) / cols
        rows_ = -(-len(secs) // cols)
        # Sized to the longest list, not to the space available: a card that is mostly empty
        # border reads as missing content.
        longest = max(len(sl) for _, sl in secs)
        ch = min((5.5 - 0.2 * (rows_ - 1)) / rows_, 1.15 + 0.27 * longest)
        for k, ((no, name), slides) in enumerate(secs):
            x = 0.45 + (k % cols) * (cw + 0.215)
            y = 1.35 + (k // cols) * (ch + 0.2)
            # Chrome, not a component: the accent means "the brain" and nothing else.
            box(s, x, y, cw, ch, INFRA, None, (), line_w=1.25)
            text(s, x + 0.15, y + 0.1, cw - 0.3, 0.42, [f"**{no}  {name}**"], size=17)
            text(s, x + 0.15, y + 0.5, cw - 0.3, 0.45, [blurbs[no]], size=11, color=MUTED)
            # outline_size: a deck whose sections list five long titles sets 10 (the floor).
            text(s, x + 0.15, y + 0.95, cw - 0.3, ch - 1.0,
                 [f"{n}   {t}" for n, t in slides], size=getattr(self, "outline_size", 11), gap=2)

    def build(self, sections, title_slide):
        """sections: [(number, name, blurb, [slide functions])]. Each function takes the deck."""
        title_slide(self)
        self.n += 1                      # slide 2 is the outline, drawn last
        for no, name, _, fns in sections:
            self.section = (no, name)
            for f in fns:
                f(self)
        self.section = None
        self.outline({no: blurb for no, _, blurb, _ in sections})
        self._move(len(self.prs.slides) - 1, 1)
        self._sections([("Overview", 2)] + [(f"{no} {name}", len(fns))
                                            for no, name, _, fns in sections])
        self._refuse()
        self.out.parent.mkdir(parents=True, exist_ok=True)
        self.prs.save(self.out)
        print(f"wrote {self.out} ({len(self.prs.slides)} slides, {len(sections)} sections)")
        bookmarks = [(self.title, 1, []), ("Outline", 2, [])]
        for sec, n, t in self.index:
            name = f"{sec[0]}. {sec[1]}"
            if bookmarks[-1][0] != name:
                bookmarks.append((name, n, []))
            bookmarks[-1][2].append((f"{n}  {t}", n))
        to_pdf(self.out, len(self.prs.slides), bookmarks, self.title)

    def _move(self, i, j):
        ids = self.prs.slides._sldIdLst
        el = list(ids)[i]
        ids.remove(el)
        ids.insert(j, el)

    def _sections(self, groups):
        """PowerPoint's navigator sections: the p14 extension python-pptx has no API for.
        LibreOffice ignores it; PowerPoint reads it."""
        p14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
        ids = [el.get("id") for el in self.prs.slides._sldIdLst]
        assert sum(c for _, c in groups) == len(ids), "every slide must be in one section"
        pres = self.prs.part._element
        ext_lst = pres.find(qn("p:extLst"))
        if ext_lst is None:
            ext_lst = etree.SubElement(pres, qn("p:extLst"))
        ext = etree.SubElement(ext_lst, qn("p:ext"))
        ext.set("uri", "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}")
        lst = etree.SubElement(ext, f"{{{p14}}}sectionLst", nsmap={"p14": p14})
        at = 0
        for k, (name, count) in enumerate(groups):
            sec = etree.SubElement(lst, f"{{{p14}}}section")
            sec.set("name", name)
            sec.set("id", "{%08X-0000-4000-8000-%012X}" % (0xA0B00000 + k, k))  # deterministic
            sl = etree.SubElement(sec, f"{{{p14}}}sldIdLst")
            for sid in ids[at:at + count]:
                etree.SubElement(sl, f"{{{p14}}}sldId").set("id", sid)
            at += count

    def _refuse(self):
        for pattern, fix in self.refuse:
            bad = [(i, t) for i, t in _all_text(self.prs) if re.search(pattern, t)]
            if bad:
                for i, t in bad:
                    print(f"slide {i}: {t[:80]!r}", file=sys.stderr)
                sys.exit(f"refusing to write the deck: {pattern!r} matched. FIX: {fix}")


def _all_text(prs):
    for i, s in enumerate(prs.slides, 1):
        for shp in s.shapes:
            if shp.has_text_frame:
                yield i, shp.text_frame.text
            if shp.has_table:
                for row in shp.table.rows:
                    for c in row.cells:
                        yield i, c.text_frame.text
        if s.has_notes_slide:
            yield i, s.notes_slide.notes_text_frame.text


# -------------------------------------------------------------------------------------- PDF

POWERPOINT = Path("/Applications/Microsoft PowerPoint.app")

# PowerPoint is sandboxed: writing the PDF to a path it was never given raises Office's "Grant
# File Access" prompt (an alert, then a file chooser: two windows), which is not scriptable. So the
# export goes through one fixed folder AND two fixed file names, granted once and then remembered
# by Office. A fresh /tmp directory per build asked again on every build, and /tmp is hidden in the
# chooser, so the target could not even be seen. A fixed folder with a per-build file name
# (deck-<pid>) still asked on every build, because the chooser opens with the FILE selected, and
# granting that grants a name that never recurs (2026-10-03).
PPT_DIR = Path(os.environ.get("DECK_PPT_DIR") or Path.home() / "Library/Caches/tech-deck")
PPT_NAME = "tech-deck-export"    # distinctive: the export closes any open presentation so named

# A warm export takes 15 to 25 s and a cold launch adds about a minute. Longer than this means
# PowerPoint sat behind a prompt that somebody answered, and the next build should not.
PPT_SLOW_S = 100

# Paths arrive as argv, never interpolated, so no path can break the script's quoting. An Apple
# event gives up after 120 s by default and a cold launch plus export takes about that long.
PPT_EXPORT = """
on run argv
    set src to item 1 of argv
    set dst to item 2 of argv
    with timeout of 540 seconds
        tell application "Microsoft PowerPoint"
            -- The name is fixed, so a copy left open by an interrupted build would be returned
            -- in place of the new file: close it first. Only this kit uses the name.
            repeat with q in (get presentations)
                if name of q is (item 3 of argv) then close q saving no
            end repeat
            open POSIX file src
            set p to active presentation
            save p in (POSIX file dst) as save as PDF
            close p saving no
        end tell
    end timeout
end run
"""


def _plain(t):
    return t.replace("**", "").replace("`", "")


def _via_powerpoint(pptx, tmp):
    """The deck as it will be read. Exported from a COPY under the fixed PPT_NAME, never the
    deck's own path: opening a path PowerPoint already has open returns its in-memory document
    (the previous build), and the PDF would be stale while looking current. The script closes any
    open PPT_NAME first for the same reason. The copy and the PDF live in PPT_DIR, not `tmp`; the
    PDF is moved into `tmp` before anything reads it."""
    was_running = subprocess.run(
        ["osascript", "-e", 'application "Microsoft PowerPoint" is running'],
        capture_output=True, text=True).stdout.strip() == "true"
    PPT_DIR.mkdir(parents=True, exist_ok=True)
    src = PPT_DIR / f"{PPT_NAME}.pptx"
    out = src.with_suffix(".pdf")
    out.unlink(missing_ok=True)
    shutil.copy(pptx, src)
    t0 = time.monotonic()
    try:
        r = subprocess.run(["osascript", "-", str(src), str(out), src.name], input=PPT_EXPORT,
                           capture_output=True, text=True, timeout=600)
    finally:
        src.unlink(missing_ok=True)
        if not was_running:          # leave PowerPoint as it was found
            subprocess.run(["osascript", "-e", 'tell application "Microsoft PowerPoint" to quit'],
                           capture_output=True, timeout=60)
    if r.returncode != 0 or not out.exists():
        # -1712 after the full 540 s: PowerPoint is behind a modal prompt (an Automation or
        # file-access grant). A `quit` then answers "User canceled" (-128). Do not kill it.
        sys.exit(f"PowerPoint did not write a PDF (rc={r.returncode}): {r.stderr.strip()[-300:]}"
                 f"\nFIX: rebuild, and in PowerPoint's Grant File Access prompt select the folder "
                 f"{PPT_DIR} (Cmd-Shift-G, paste the path) and grant it: once, then it is "
                 "remembered. No prompt visible: System Settings > Privacy & Security > Automation. "
                 "Or set DECK_PDF_VIA=soffice")
    took = time.monotonic() - t0
    if took > PPT_SLOW_S:
        print(f"PowerPoint took {took:.0f} s, so it probably waited on a Grant File Access prompt. "
              f"FIX: if the next build prompts again, select the FOLDER {PPT_DIR} in the chooser "
              "(not the file in it) before granting")
    moved = Path(tmp) / out.name
    shutil.move(out, moved)
    ver = subprocess.run(["defaults", "read", str(POWERPOINT / "Contents/Info"),
                          "CFBundleShortVersionString"], capture_output=True, text=True)
    return moved, f"Microsoft PowerPoint {ver.stdout.strip() or '(version unread)'}"


def _via_soffice(pptx, tmp):
    """LibreOffice, headless. A PRIVATE profile: with a shared one, soffice hands the job to a
    running LibreOffice and exits 0 having converted nothing."""
    soffice = os.environ.get("SOFFICE") or shutil.which("soffice")
    if not soffice:
        sys.exit("no soffice: the .pptx was written, the PDF was not. FIX: brew install --cask "
                 "libreoffice, or set SOFFICE to its soffice binary")
    r = subprocess.run([soffice, f"-env:UserInstallation=file://{tmp}/profile", "--headless",
                        "--convert-to", "pdf", "--outdir", tmp, str(pptx)],
                       capture_output=True, text=True, timeout=300)
    out = Path(tmp) / pptx.with_suffix(".pdf").name
    if r.returncode != 0 or not out.exists():
        sys.exit(f"soffice did not write a PDF (rc={r.returncode}): {r.stderr.strip()[-300:]}"
                 "\nFIX: run the same soffice command by hand and read its error")
    ver = subprocess.run([soffice, "--version"], capture_output=True, text=True)
    return out, (ver.stdout.split("\n")[0].rsplit(" ", 1)[0] or "LibreOffice")


def to_pdf(pptx, slides, bookmarks, title):
    """The PDF beside the .pptx, from the same build. PowerPoint where installed, else
    LibreOffice; DECK_PDF_VIA=powerpoint|soffice forces one, DECK_PDF_VIA=none skips it. The
    renderer goes into /Creator."""
    from pypdf import PdfReader, PdfWriter
    pptx = Path(pptx)
    via = os.environ.get("DECK_PDF_VIA") or ("powerpoint" if POWERPOINT.exists() else "soffice")
    if via not in ("powerpoint", "soffice", "none"):
        sys.exit(f"DECK_PDF_VIA={via!r}. FIX: set it to powerpoint, soffice or none, or unset it")
    pdf = pptx.with_suffix(".pdf")
    if via == "none":
        # A quick iteration on the .pptx. An existing PDF is left alone (it may be committed),
        # but it now describes an earlier build, so say so rather than let it look current.
        if pdf.exists():
            print(f"PDF skipped (DECK_PDF_VIA=none): {pdf} is from an EARLIER build. "
                  "FIX: rebuild without DECK_PDF_VIA=none before using or committing it")
        else:
            print("PDF skipped (DECK_PDF_VIA=none)")
        return

    pdf.unlink(missing_ok=True)      # a failed render must not leave the last build's PDF
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="deck-") as tmp:
        out, renderer = (_via_powerpoint if via == "powerpoint" else _via_soffice)(pptx, tmp)
        logging.getLogger("pypdf").setLevel(logging.ERROR)   # PowerPoint's xref needs repair
        reader = PdfReader(out)
        pages = len(reader.pages)
        if pages != slides:
            sys.exit(f"the PDF has {pages} pages for {slides} slides. FIX: find the slide that "
                     "did not render")
        # Neither renderer writes useful bookmarks; rebuild them from the deck's own outline.
        w = PdfWriter()
        w.append(reader, import_outline=False)
        for lab, page, children in bookmarks:
            parent = w.add_outline_item(_plain(lab), page - 1)
            for child, cpage in children:
                w.add_outline_item(_plain(child), cpage - 1, parent=parent)
        w.page_mode = "/UseOutlines"
        w.add_metadata({"/Title": title, "/Creator": f"{Path(sys.argv[0]).name} via {renderer}"})
        final = Path(tmp) / "final.pdf"
        with open(final, "wb") as fh:
            w.write(fh)
        got = [o.title for o in PdfReader(final).outline if not isinstance(o, list)]
        if got != [_plain(b[0]) for b in bookmarks]:
            sys.exit(f"the PDF's bookmarks did not survive the write: {got}. FIX: check the "
                     "pypdf pin in requirements.txt")
        shutil.move(final, pdf)
    print(f"wrote {pdf} ({pages} pages, {len(bookmarks)} top-level bookmarks, via {renderer})")
