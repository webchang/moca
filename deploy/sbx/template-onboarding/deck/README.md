# Template lifecycle overview deck

A generated deck: `make_template_lifecycle_pptx.py` is the source of truth, and the PDF beside it
is its build output. Never edit the `.pptx` or the PDF by hand; change the script and rebuild.

| File                               | What                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `make_template_lifecycle_pptx.py`  | one function per slide; its docstring names the sources, in the order they win |
| `deck_kit.py`                      | the palette, shapes and build (a copy of the tech-deck kit)                    |
| `template-lifecycle-overview.pdf`  | the build output, committed                                                    |
| `template-lifecycle-overview.pptx` | the build output, not committed (`.gitignore`)                                 |

Build, from this folder, in its own venv:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python make_template_lifecycle_pptx.py    # the .pptx and the PDF (PowerPoint, else LibreOffice)
```

`DECK_PDF_VIA=soffice` forces LibreOffice; `DECK_PDF_VIA=none` writes the `.pptx` only. The build
refuses to save a deck holding a 12-digit id, a registry host, an IP address or an internal host
name.
