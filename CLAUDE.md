# Handwriting engine: notes for Claude

A browser app. The user writes samples with an Apple Pencil on an iPad (the Teach tab). After that they type any text, or TeX-style math, and get it back in their own handwriting (the Write tab). Output is vector ink: canvas, SVG, PNG, or placed on a PDF.

Plain JavaScript, no build step, no framework. Node 18+ for the tests and scripts. Everything runs in the browser except `scripts/` and `tools/`.

## What the user needs to do (you cannot do this part)

The handwriting is theirs. Only they can write the samples, and only on a device with a Pencil (or a finger/mouse, which works but looks worse). Walk them through it:

1. Get the app in front of them on the iPad (see "Running it").
2. Teach tab, rounds in this order: **Alphabet, Capitals, Numbers, Symbols, Single letters, Math, Tricky letters, Numbers in a row, Common words, Full lines**. Each is one word, letter or sentence at a time on the pad, then Next. Write at normal speed and size, on the solid line. About 25 to 30 minutes in total.
3. In the Write tab, tick **Fix mode** and tap any letter on the page that looks wrong: it is replaced and that example is left out for good (Undo is right there). Or, in the Teach tab, look at "What it learned" and tap any letter in the Coverage grid to see every example the app cut out for it, and tap the ones that do not look like the letter to leave them out. This is the most effective way to improve quality, especially for **a, e, o, r, u** and the digits. The Tricky letters round (those five at the start, middle and end of words) and Numbers in a row exist to give those a good supply of examples.
4. Export (Teach tab) saves `my-handwriting.json`. **That file is their handwriting. Do not commit it, do not paste it anywhere.** `.gitignore` already skips `my-handwriting*.json`.

If a result looks wrong, ask which letters or words give it away, and fix those specifically. Guessing at "make it more natural" does not work; the fixes that mattered were all specific (a letter pool containing mis-cut examples, a symbol scaled wrongly, a single letter carrying a run-in stroke it only has when written alone).

## Running it

    npm run serve          # http://localhost:8080 (npx http-server)
    npm test               # unit tests (node:test), about 30 s
    npm run e2e            # browser tests, needs Playwright: npm install && npx playwright install chromium
    npm run e2e:protected  # tests the password-protected build
    npx eslint src tests scripts tools

The Pencil needs the app on the iPad itself. Two ways:

- **Same Wi-Fi:** `npm run serve`, then open `http://<computer's address>:8080` in Safari on the iPad.
- **Published, password protected:** `SITE_PASSWORD='...' npm run deploy:pages` builds one encrypted page (AES-256-GCM, PBKDF2) and adds a normal commit on a `gh-pages` branch. In the GitHub repo settings, set Pages to deploy from `gh-pages`. The build refuses passwords under 12 characters unless `ALLOW_SHORT_PASSWORD=1`; a short password can be cracked offline because the encrypted file is public, so only set that if the user understands and says so. Never force-push `gh-pages`; the script does not. Never write the password into a file or commit it.

After `deploy:pages`, "Published to gh-pages" only means the branch was pushed. The site is not updated until GitHub's "pages build and deployment" workflow finishes, and that can stall (a GitHub Actions incident once left it queued for over an hour, and every newer push cancelled the waiting run). Check the run (Actions tab, or the GitHub MCP `actions_list`) and confirm the live page changed (`curl -sI <site>` and look at `last-modified` and `content-length`) before telling the user it is live. While a run is pending, do not push to `gh-pages` again; that cancels it. Browsers also keep the old page for about 10 minutes, and an iPad home-screen app may need to be closed and reopened.

Samples live in the browser's localStorage, per origin. Use Export/Import to move them between devices.

## How it works

Data flow: `capture.js` records strokes -> `align.js` cuts each word into letters along the pen path -> `style.js` builds the per-letter pools and the writer's profile -> `synth.js` picks examples and joins them -> `render.js` draws the ink.

| File | Job |
| --- | --- |
| `src/capture.js` | The pad (Pointer Events, coalesced events, pen vs touch palm rejection, pressure or speed-based width). |
| `src/align.js` | Forced alignment: a DP that cuts a word into letters. Fits a per-word scale and baseline first, because people do not write at the guide's size. Crossing strokes (x, the bar of a t) stay together. |
| `src/style.js` | `buildStyle(rawWords)`: pools of examples per character (`byChar`), the writer's profile, word-gap and drift rhythm from full lines, flags on examples (see below). Cached per raw word (WeakMap), so a rebuild after adding one word is about 50 ms. |
| `src/synth.js` | `layout(style, text, opts)`: beam search over examples with join costs, Hermite bridges between joined letters, nearest-ink spacing for unjoined ones, small deformations. |
| `src/math.js` | `layout(style, tex, opts)`: TeX-style math (`x^2`, `\frac{a}{b}`, `\sqrt{x}`, `\lim_{x \to 0}`, `\int_0^1`, `\sum_{i=1}^{n}`), brackets that stretch. Draws a hand-wobbled stand-in for any symbol the writer has not written, and uses theirs once they have (operators need two samples). |
| `src/render.js` | Strokes to filled outlines (SVG path data) for canvas/SVG/PNG. Constant-width pen by default. |
| `src/lines.js` | Splits a written line into words. |
| `src/prompts.js` | The Teach rounds. |
| `src/sheet.js`, `src/sheetui.js` | The Sheet tab: open a PDF or photo, drag answer boxes onto it, type answers, save the PDF with the ink drawn in. `sheet.js` is the part without a screen (fitting an answer to its box, writing ink into a PDF with pdf-lib, and `findBlanks`); `sheetui.js` is the page (pdf.js to show it). `findBlanks` works on a picture of the page (2 px/pt, drawn off screen), not the PDF's drawing commands, so scans and photos work too: ink is "darker than the local paper" so a shadow does not matter, empty boxes are enclosed white regions that fill their rectangle with no ink inside (table cells included), answer lines are thin long horizontal runs with nothing above them that are not a box edge or the top or bottom of a frame (both ends turning down or up). |
| `vendor/` | pdf.js and pdf-lib, unmodified, only for the Sheet tab. `loadLib` in `sheetui.js` loads them on first use; the protected build carries them as text in `window.HW_LIBS`. See `vendor/README.md`. |
| `mcp/server.js`, `mcp/tools.js`, `mcp/pdfinfo.js`, `mcp/raster.js` | An MCP server over stdio (hand-written JSON-RPC, no dependencies) so an assistant can call the engine: `handwriting_status`, `write_text` (a PNG drawn by `raster.js`, or with `format: "svg"` the SVG markup as a text block, because MCP has no SVG image type; the .svg is always saved, sized in points), `inspect_pdf` (page text and ruled lines through pdf.js in Node), `fill_pdf` (same `sheet.js` code as the Sheet tab). Reads the exported handwriting file from `--samples` / `HANDWRITING_FILE` / `my-handwriting.json` in the current folder. stdout is the protocol, so anything a library prints is sent to stderr. The built style is cached with `v8.serialize` in `.handwriting-cache/` next to the samples (keyed by the samples' hash and the engine code; building takes ~7 s, loading ~0.4 s), because clients spawn the server per call. It holds the same strokes as the samples, so it is private (0700/0600) and gitignored. `--http PORT --token SECRET` serves the same thing over HTTP (bearer token required). |
| `mcp/sealed.js`, `scripts/seal-samples.js` | `seal`/`unseal`: the samples gzip'd and AES-256-GCM locked with a PBKDF2 key, JSON with `"kind":"handwriting-samples"` first. The server detects a sealed file by that, so `--samples` takes either kind and `--samples-url` takes an address (needs `--password` / `HANDWRITING_PASSWORD`). Publishing a sealed copy to the public site is not done by the deploy script yet: it is the user's call, and the password strength is the only protection. |
| `scripts/pack.js`, `src/download.js`, `docs/handwriting-engine-guide.pdf` | The Download button (bottom left, published site only). `pack.js` deflates the git-tracked project files plus both MCP builds into `window.HW_PACK`, which `build-protected.js` puts in the encrypted page just before `download.js`; the browser assembles the zip and can add the user's `my-handwriting.json` (off by default, since the zip gets sent to friends). Files must be `git add`ed to be packed. The guide PDF is tracked with `git add -f` (`*.pdf` is ignored); it must never contain a password. |
| `NIKO_PASSWORD`, `SEBA_PASSWORD` (build-protected.js, pack.js `PROFILES`) | More passwords on the login page. The page holds the app locked once per package kind with a random key (`var B`, one blob each: `full` and `ai`) and one slot per password (`var S`: PBKDF2 of that password locks the blob's key, `wrap` in `build-protected.js`), so a part with the same package adds almost nothing (~11 MB in all). The login script sets `window.HW_PROFILE` (an opaque id from `partId`, never the person's name: the page is public) and `HW_PROFILE_KIND` (`full` or `ai`) ahead of the app's scripts. That namespaces localStorage (`<id>:hw.…`, see `NS` in `app.js`/`sheetui.js`; the main part keeps the plain keys, so existing data stays). `full` keeps the whole-project Download; `ai` shows `#guestNote` and the button "Download for my AI": a small zip (`handwriting-for-ai/`: the user's `my-handwriting.json` from the browser, both servers, the guide, `docs/FOR-THE-AI.txt`). Passwords come from the environment only, like `SITE_PASSWORD`; add a person by adding to `PROFILES`. |
| `scripts/build-site-extras.js` | Writes `handwriting-mcp.js`, `handwriting-mcp-pdf.js` (+ `.sha256`) and `mcp.txt` into the site folder; `deploy-pages.sh` calls it, so the MCP server is fetchable at `<site>/handwriting-mcp.js`. Program only: never put samples on the site, it is public (the password only protects the app page). |
| `scripts/build-mcp.js` | Folds `mcp/` and the `src/` files it needs into ONE file with no dependencies (`npm run build:mcp` → `dist/handwriting-mcp.js`; `--pdf` adds the PDF libraries). Needs plain relative `require('../src/x')` calls in `mcp/` so it can find them; keep PDF-only requires lazy (inside functions). |
| `src/app.js`, `index.html`, `styles.css` | The UI. `window.HW_APP` exposes `style`, `words`, `layout` for debugging. |
| `scripts/build-protected.js`, `deploy-pages.sh`, `login.template.html` | The password-protected site. |
| `tools/handwrite-blocks.js`, `tools/place_on_pdf.py` | Write text or math in the user's hand onto a PDF (see below). |

Coordinates inside the engine: x right, **y up**, baseline 0, x-height 1, de-slanted. The page conversion to pixels (y down, slant) happens at the end of `layout`. A "unit" is one cut-out letter: `{ch, strokes, marks, entry, exit, box, ...}`.

Flags `style.js` puts on units (all consumed as costs in `synth.chooseUnits`): `iso` (written on its own, so never mis-cut), `odd` and `dev` (unlike the writer's other examples), `hc` (implausible shape/height), `wrong` (looks more like another letter than its own single-letter reference), `far`, `open` (the writer closes this letter, this copy is open), `stray` (carries a scrap of a neighbour), `skipped` (crossed out by the user in the letter check; kept out of `byChar`, listed in `allByChar`).

Raw sample format (the export file): `{version: 1, words: [{text, xh, baseline, strokes: [[[x, y, t, pressure], ...]], iso?, line?, pos?, skip?}]}`. `skip` is `[{i, ch}]`, the letters the user crossed out.

## Things that bit us (do not repeat)

- **Each word draws from its own random streams** (`synthWord` takes one number from the layout's `rng` and builds one stream for choosing letters and one for spacing/wobble). That is what lets Fix mode replace one letter without disturbing the page: `layout` takes `pins` (one unit id or null per letter per word) and a pinned letter uses exactly that example. Keep it that way; sharing one stream across words makes every edit reshuffle everything after it. `layout().words[i]` has `ids`, `choices` and `spans` (x range of each letter on the page) for tracing a tap back to its example.
- **Words the writer wrote are reused whole** (`wholeWordPins` in `synth.js`, `style.wholeWords`): a typed word that matches a recorded word is pinned to that word's own letters, which cannot have been mis-cut against a different word. It is the cheapest quality win there is, so the more everyday words the writer has recorded (the Common words round), the better every page. Reuse falls off (0.55 per repeat) so a page does not paste the same word twice. Do not try to rank takes with a shape-similarity score: tested against a writer's data, clean single letters and cut-out letters scored the same, and it took 17 s.
- **Neatness is the lever that works for legibility.** The writer's single letters (`iso`) are the only examples known to be clean, because nothing was cut. `opts.neatness` (0..1, default 0.5) raises how much they are preferred over cut-out letters; at 0 it is the old mix (14% single letters), at 1 it is about 64%. A single letter's run-in stroke (the tail on an "m") is trimmed by `trimRunIn` in `style.js`. Things that were tried and did not help, with the data: a shape-similarity ambiguity score (clean and cut letters scored the same, 17 s), a stronger pull towards short real runs (13% to 20% real-neighbour joins, no visible change), and matching letters to their position in the word (93% matched, but the pictures were no better: there are too few good first and last examples of each letter). Use the letter check or Fix mode for what is left.
- A crossed-out example must never come back by any route. The "natural continuation" shortcut in `chooseUnits` used to add the next letter of the same recorded word without checking `skipped`.

- **Never mutate a cached unit.** `align.js`/`style.js` cache per raw word, so a mutation compounds on every rebuild. Make a copy (see `shrinkSingleLetters`).
- Symbol-only words (`(`, `+`, `=`) have no letters to size them by. They take the writer's usual scale from the profile (`profile.s`, `profile.dy`). Fitting each to its own height made every bracket the size of a lowercase letter.
- Single letters (the `iso` round) are written bigger and wider than the same letters inside words and carry a run-in stroke. They are shrunk by the writer's own in-word ratios and only used to start a word.
- The wrong-letter check compares shape only, so it cannot tell `i` from `l` (a stem is a stem at any height). Stems and punctuation are exempt (`NO_SHAPE_CHECK` in `style.js`). A safety valve turns the check off if it would flag more than 10% of letters.
- Shape distance does not separate good from bad `e`s for most people (their real e's range from c-shaped to loops). Use the letter check, not another heuristic.
- Digits cut out of number words are usually poor. The Math round has digits on their own; ask for it before generating anything numeric.
- A stroke's own width `w` comes from capture speed. The constant pen ignores it (and the tapers) on purpose, because the target (a note-taking app's pen) has one width.
- Test helpers: `tests/synth-writer.js` writes fake handwriting (print or cursive, with jitter and slant) so tests need no real data.

## Making it look like a particular app's pen

`render.js` has `CONSTANT_W`: the constant pen is `0.12` x-heights wide at pen thickness 1.00. That number was measured from a Notability export: a vertical line at thickness 3 was 1.2 pt wide, and lowercase letters in the same sample were about 10 pt tall. To match another pen or thickness, ask the user to export a page from their app with a few lines drawn at the thicknesses they use and a word written beside each, then measure line width and x-height from the PDF (PyMuPDF `get_pixmap` at 600 dpi plus a column scan works; the ink colour is the path's fill colour in `page.get_drawings()`). Then set the colour (`#1749b3` here is that app's blue) and `CONSTANT_W = width / xheight / 0.085`.

## Writing answers onto a PDF (homework, forms)

The easy way, for the user to do themselves: the Sheet tab (open the PDF, drag a box per answer, type, Save PDF). Boxes are `{page, x, y, w, h, text, kind, xhPt, seed, auto}` in points from the page's top-left corner. If you have the MCP server connected (`mcp/`), `inspect_pdf` then `fill_pdf` do this without scripts. Otherwise use the tools below, which put the same ink on the same kind of page.

    pip install pymupdf
    node tools/handwrite-blocks.js my-handwriting.json blocks.json out/
    python3 tools/place_on_pdf.py assignment.pdf out/ answered.pdf 110

`tools/example-blocks.json` shows the format: text or math blocks with a top-left position and width in PDF points, plus optional hand-drawn lines/arrows for marking graphs. Render the assignment pages to PNG first (`pymupdf` `get_pixmap(dpi=120)`) and look at them to find the blank space; positions in points are the pixel position times 72/dpi. Check the result by looking at the page images before handing it over, and look at the tops of tall things (digits, brackets, a slash, l, h): each block is a small box, so anything outside it is cut off flat. The tool grows each box with `render.fitLayout` to prevent that, but a bad edit there shows up as flat-topped letters. Read any numbers off graphs programmatically if you can (count dots, find tick positions) instead of eyeballing.

Be honest with the user about what the engine cannot do well yet: numbers are only as good as the digit examples, and a result with illegible digits is not finished. Whether it is acceptable to hand in generated handwriting is the user's call and their school's or employer's rules; do not decide that for them, and do not fill in their name or anything else you were not given.

## Conventions

- Match the surrounding code: small functions, comments that explain why, no dependencies in `src/` (it runs from a `<script>` tag and from Node via the same file).
- Every behaviour change gets a test (`tests/*.test.js`); UI behaviour gets a step in `tests/e2e.js`. Run lint, `npm test` and `npm run e2e` before you commit.
- Keep commit messages and the README plain and specific. Follow whatever the user says about authorship and attribution lines.
- Never commit samples, passwords, tokens or exported pages. Do not create a pull request unless asked.
