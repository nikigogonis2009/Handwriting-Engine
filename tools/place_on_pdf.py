#!/usr/bin/env python3
"""Place the handwriting blocks made by tools/handwrite-blocks.js on the pages of a PDF.

    pip install pymupdf
    python3 tools/place_on_pdf.py <input.pdf> <outDir> <output.pdf> [png-dpi]

Also writes page0.png, page1.png ... next to the output when a dpi is given, to check the result by eye.
"""
import json
import os
import sys

import pymupdf


def hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(2)
    src, out_dir, dst = sys.argv[1:4]
    dpi = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    doc = pymupdf.open(src)
    man = json.load(open(os.path.join(out_dir, 'manifest.json')))
    for b in man['blocks']:
        svg = pymupdf.open(os.path.join(out_dir, b['name'] + '.svg'))
        part = pymupdf.open('pdf', svg.convert_to_pdf())
        rect = pymupdf.Rect(b['x'], b['y'], b['x'] + b['w'], b['y'] + b['h'])
        doc[b['page']].show_pdf_page(rect, part, 0)
    color = hex_to_rgb(man['ink'])
    by_page = {}
    for m in man['marks']:
        by_page.setdefault(m['page'], []).append(m)
    for page_no, marks in by_page.items():
        shape = doc[page_no].new_shape()
        for m in marks:
            for line in m['lines']:
                shape.draw_polyline([(p['x'], p['y']) for p in line])
                shape.finish(color=color, width=man['penPt'], lineCap=1, lineJoin=1, closePath=False, fill=None)
        shape.commit()
    doc.save(dst)
    if dpi:
        base = os.path.splitext(dst)[0]
        for i, page in enumerate(doc):
            page.get_pixmap(dpi=dpi).save(f'{base}_page{i}.png')
    print('saved', dst)


main()
