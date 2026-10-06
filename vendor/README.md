# Vendored libraries

Used only by the Sheet tab, and loaded only when it is opened.

| File | What | Version | Licence |
| --- | --- | --- | --- |
| `pdf.min.js`, `pdf.worker.min.js` | [pdf.js](https://github.com/mozilla/pdf.js), reads and draws PDF pages | 3.11.174 | Apache-2.0 (`LICENSE.pdfjs`) |
| `pdf-lib.min.js` | [pdf-lib](https://github.com/Hopding/pdf-lib), writes ink into a PDF | 1.17.1 | MIT (`LICENSE.pdf-lib`) |

Both are the unmodified files from the npm packages `pdfjs-dist` and `pdf-lib`. The worker script is loaded as an ordinary script
(not as a Worker), so pdf.js runs in the page; that keeps everything in the single self-contained page the protected build makes.
