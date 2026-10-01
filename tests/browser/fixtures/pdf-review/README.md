These synthetic fixtures reproduce the independent PR22 review's CMap, JPEG2000,
complete CCITT Group4 strip, embedded-font rotation and tagged-semantics defects.
Browser tests consume the committed PDFs; Python is not needed to run them.

To regenerate, use a disposable virtual environment with `reportlab==4.4.9`,
`Pillow==12.3.0` and `pypdf==6.10.0`, then run:

```sh
REVIEW_FIXTURES=tests/browser/fixtures/pdf-review python3 tests/browser/fixtures/pdf-review/generate.py
```

The source checks JPEG2000 support and requires one complete Group4 TIFF strip.
`REVIEW_FONT` can select another location of DejaVuSans.ttf; the default is
`/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`. Its redistribution notice is
retained in `FONT-NOTICE.txt`. All text and drawings are invented fixture content.
PDF timestamps/identifiers can differ on regeneration; the committed files are
recorded in `SHA256SUMS`. These fixtures establish narrow regressions, not general
PDF compatibility, total memory bounds or network-byte limits.
