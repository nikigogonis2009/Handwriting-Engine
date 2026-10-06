# Handwriting Engine

Write a few sentences with an Apple Pencil and the app learns your handwriting. After that you can type any text and it writes it back in your hand.

It runs in the browser. Nothing is uploaded; your samples stay in the browser's local storage.

## Getting started with Claude Code

Unzip the folder, open it in Claude Code, and say: "Read CLAUDE.md and get me set up." `CLAUDE.md` explains how the app works, what you need to write yourself, how to run and publish it, and the mistakes to avoid. You need Node 18 or newer. To use the Pencil, the app has to be open on the iPad (same Wi-Fi with `npm run serve`, or published with a password, see below).

## Using it

1. Open the Teach tab and write each highlighted word on the solid line of the pad, then tap Next. The first round covers every lowercase letter. The later rounds add capitals, numbers and symbols, plus a round of common words so letter pairs look natural.
2. Look at "What it learned". Each letter it cut out of your words has its own colour. If a word looks wrong, tap it and write it again.
3. Switch to the Write tab, type some text and adjust size, slant, spacing, pen and paper. "Write it again" gives a new take. You can save the result as PNG or SVG.

The Single letters round has you write each letter on its own (lowercase twice, capitals once). Those need no cutting, so they are always clean examples, and the app uses them as a reference to catch letters it cut out of your words wrongly: a cut-out letter that looks clearly more like a different letter's reference than its own gets avoided. If that comparison would flag more than one letter in ten, it assumes it can't tell your letters apart and switches itself off.

The Math round has you write each digit and math symbol on its own (digits and operators twice), and Numbers in a row has numbers with decimal points, so the app has clean digits. Tricky letters has words with a, e, o, r and u at the start, middle and end, two of each; those letters are the hardest to cut out of words cleanly, so this gives the app plenty of good examples of them.

Neatness (a slider in the Write tab) sets how much the page leans on your clean single letters instead of letters cut out of your fast writing. At 0% it is the usual mix; higher is easier to read and a little more like print. A short flat run-in stroke on a single letter (the little tail on an "m") is trimmed off, so those letters work anywhere in a word.

Common words has about 90 everyday words. When the text you type contains a word you wrote, the app writes it back from your own strokes instead of building it letter by letter (the "Use my real words" slider sets how willingly, 25% by default; a word used again and again on a page is varied, not pasted). So every common word you write improves every page.

The Full lines round has you write whole sentences on one line. From those the app learns how you really space words and how your baseline, size and slant drift along a line, and uses that when it writes. The words in each line also count as extra samples. At least 3 lines are needed. Word gaps are taken as measured; baseline, size and slant drift are measured less reliably from short lines, so they are kept within ordinary human ranges. The Natural variation slider scales the drift (30% is the default, lower is neater).

Math mode (a checkbox under the text box in the Write tab) lays out math in your hand. It reads TeX-style input: `x^2`, `x_1`, `\frac{a}{b}`, `\sqrt{x}`, `\lim_{x \to 0}`, `\int_0^1 x\,dx`, `\sum_{i=1}^{n}`, `\sqrt[3]{x}` (also typed as `sqrt(x)` or `cubert(x)`), `\text{ so }` for plain words in the middle of math, and `->`, `<=`, `>=`, `!=` for the arrows and comparisons. Ordinary spaces are ignored, as in TeX; `\ `, `\,`, `\;` and `\quad` are spaces that stay. Exponents and subscripts are smaller and shifted, fractions are stacked with a bar, and brackets stretch to fit what is inside. Letters and digits come from your samples. For symbols, the Math round in the Teach tab has you write each one on its own (the operators twice); a symbol you haven't written yet is drawn for you with a small wobble, and your own is used as soon as you have written it. Plain paper looks best for math.

Fix mode (a checkbox above the page in the Write tab) is the quickest way to clean up wrong letters. Tick it, then tap any letter on the page that looks wrong. That letter is replaced by another example of the same letter, the example it came from is left out from then on, and every other letter on the page stays exactly as it was. Undo puts it back. It works in ordinary text, not in Math mode. It changes the same "left out" list as the letter check in the Teach tab.

Export (in the Teach tab) saves your samples to a file, and Import loads them on another device.

## Filling in a worksheet

The Sheet tab puts your handwriting on a real worksheet, with nothing to install and nothing sent anywhere.

1. Tap **Open worksheet** and choose the PDF, or a photo or screenshot of it (PNG or JPEG).
2. The blanks on the page are marked in green: answer lines (printed rules and rows of underscores with nothing written on them) and empty boxes, including empty table cells. Tap one and an answer box is put there, sitting on the line. **Find blanks** turns the marks off and on. For anywhere else, tap **Draw answer box** and drag a rectangle where the answer goes. Drag a box to move it, or drag the round handle at its corner to resize it. A box can be on any page; use the arrows to turn pages.
3. With a box selected, type the answer in the panel on the right. It is written in your hand straight away, in the pen and colour set in the Write tab. Choose **Math** to type it as math (`\frac{a}{b}`, `x^2`), and **Another take** if you want that answer written differently.
4. An answer that is too long for its box is written smaller until it fits (unless you untick that), and the panel says so. Letter height sets the size it starts from, in points.
5. **Save PDF** gives back the worksheet with the writing drawn on top as vector ink, so it stays sharp. **Save page as PNG** saves the page you are looking at as a picture.

The boxes and answers are remembered on this device for that file, so you can close the page and open the same file again later. A PDF that is locked with a password has to be unlocked first, and pages that are rotated inside the PDF can be shown but not saved as PDF yet (use the PNG).

The PDF code (`vendor/`, pdf.js and pdf-lib) is only loaded the first time a worksheet is opened.

## Letting an AI assistant use it (MCP)

`mcp/server.js` is an MCP server, so an assistant such as Claude Code or Claude Desktop can write in your hand and fill in worksheets when you ask it to ("fill in the answers on homework.pdf in my handwriting"). It runs the same engine as the web app on your computer, from the file the Export button in the Teach tab saves. It does not open the website, and the handwriting file never leaves your computer: the assistant only gets the pictures and text the tools return.

You need Node 18 or newer and your `my-handwriting.json`.

    # Claude Code
    claude mcp add handwriting -- node /full/path/to/mcp/server.js --samples /full/path/to/my-handwriting.json

For Claude Desktop, add this to its config file (`mcpServers` section) and restart it:

    "handwriting": {
      "command": "node",
      "args": ["/full/path/to/mcp/server.js", "--samples", "/full/path/to/my-handwriting.json", "--out", "/full/path/to/results"]
    }

Building your handwriting takes several seconds, so the first call after a fresh start is slow (about 7 s for a full set of samples). The built result is kept in a `.handwriting-cache` folder next to your samples file (private to you, and git skips it), so every later start takes under half a second, even if your assistant starts the program for each call. `--cache DIR` moves it and `--no-cache` turns it off. A server that stays running (`--http`) keeps it in memory.

`--out` is where it saves what it makes (default: a `handwriting-out` folder in the directory the server starts in).

Tools:

- `handwriting_status`: is your handwriting loaded, and which characters have no sample yet.
- `write_text`: writes text or TeX-style math and returns it. By default that is a PNG picture. With `format: "svg"` it returns the SVG markup itself as text (transparent, sized in points, ready to save as a `.svg` file), and `"both"` gives both. Both files are saved either way. Start the server with `--format svg` (or `HANDWRITING_FORMAT=svg`) to make SVG the default.
- `write_batch`: the same as `write_text` for a whole list of items in one call, so the handwriting is loaded once. A bad item is reported by number and the rest still come back; `return_images: false` returns just the saved file paths.
- `inspect_pdf`: for each page, the printed text and the ruled lines, with positions in points from the top-left corner. This is how the assistant finds where an answer goes.
- `fill_pdf`: writes answers onto a PDF and saves a new file (the original is never changed). Each answer has a page, an x position, a width, and either a y (top of the box) or the y of the printed line it should sit on. Long answers are written smaller to fit, and the reply says which ones were.

### One file, and a web address

`npm run build:mcp` folds the server and the whole engine into one file, `dist/handwriting-mcp.js` (about 150 KB), that needs nothing else: no npm packages, no project folder. Copy it anywhere next to your `my-handwriting.json` and run `node handwriting-mcp.js` (it looks for `my-handwriting.json` in the folder it is started in, then next to itself, or use `--samples`). That file has `handwriting_status` and `write_text`. `node scripts/build-mcp.js --pdf --out dist/handwriting-mcp-pdf.js` also adds `inspect_pdf` and `fill_pdf`, and makes the file about 2 MB.

`write_text` returns the picture as an MCP image (a base64 PNG). A client that cannot show images can ask for the base64 as text too with `include_base64: true`.

Deploying the site also publishes the server next to the login page, so an assistant can fetch it instead of you uploading it each time: `https://<you>.github.io/<repo>/handwriting-mcp.js` (and `handwriting-mcp-pdf.js`), each with a `.sha256` file, and `mcp.txt`, a plain-text page of instructions an assistant can read. These files are only the program. Your handwriting is not in them and is not on the site: it stays in your own `my-handwriting.json`, which still has to be given to wherever the server runs.

### Keeping the handwriting locked

`SEAL_PASSWORD='a long password' node scripts/seal-samples.js my-handwriting.json handwriting.enc.json` locks your samples with a password (gzip, then AES-256-GCM with a PBKDF2 key, the same recipe as the protected page) and writes a file that is safe to keep anywhere. Nothing is uploaded. Passwords under 12 characters are refused, because anyone who can download a sealed file can guess at it offline.

The server opens it with `--samples handwriting.enc.json --password ...`, or with `--samples-url <address of the file>`. Prefer `HANDWRITING_PASSWORD` in the environment to `--password`, so the password stays out of process lists. The unlocked samples are only ever held in memory; the speed-up cache described above does hold them unlocked, so keep that folder private.

To use it as a web address instead of a program, add `--http 8787 --token <a secret of 16 or more characters>`. It then answers MCP requests at `http://127.0.0.1:8787/mcp` (POST, header `Authorization: Bearer <token>`). It listens on your computer only. To reach it from another device, put a tunnel or an HTTPS proxy in front of it; the token is the only thing stopping other people from writing in your hand, so keep it private.

The assistant can look at the PDF itself as well as read `inspect_pdf`, which only lists text and lines, not pictures. Check the result before you hand it in. It writes only what it is asked to write, and what you hand in is your call.

## Downloading everything

On the published (password-protected) site there is a **Download everything** button at the bottom left. It gives one `handwriting-engine.zip` with the app's code, the MCP server (`handwriting-mcp.js`, and the PDF version), and the setup guide as a PDF. Tick the box in its panel to add your own `my-handwriting.json` as well; it is off by default so a zip you send to someone does not carry your handwriting. The package is built into the encrypted page by `scripts/pack.js` and put together as a zip in the browser (`src/download.js`), so it works offline once the page has loaded. It is not there when you run the app locally with `npm run serve`.

### More passwords, each with its own part of the site

`SITE_PASSWORD='...' NIKO_PASSWORD='...' SEBA_PASSWORD='...' npm run deploy:pages` puts more parts behind the same login page, one per password (the names are in `PROFILES` in `scripts/pack.js`). Each person gets the same app with their own saved data (it never mixes with anyone else's, even in one browser). **Niko's** part has the full **Download everything** button. **Seba's** is for someone whose AI cannot host a site: it has a front page with three steps and a button, **Download for my AI**, that saves a small zip: their handwriting, the two MCP servers, the guide and `FOR-THE-AI.txt`, plain instructions for an assistant that can run a program but cannot host a website or use GitHub. Nothing of the main part is in it. The two passwords must differ, and neither opens the other's part.

## Looking like a note-taking app

The default pen is a constant-width pen with round ends, like a ballpoint in a note-taking app, in Notability's blue (`#1749b3`) on white paper. Its width, at the default 1.00, matches Notability's thickness 3 for handwriting of about 10 pt x-height on a letter page (measured from an exported sample page; 0.4 is thickness 1). Under Look, "Pen thickness" sets the width and "Pen" switches to the older speed-based line. Under Paper & ink, "Exact ink colour" takes any colour, so you can match your own pen.

## Apple Pencil

Once the Pencil has been used on the pad, finger and palm touches are ignored (there is a checkbox to turn that off). If the Pencil reports pressure, it sets the line weight. If it doesn't (the USB-C Pencil has no pressure sensor), line weight follows pen speed instead.

## Running and publishing

There is no build step for the app itself. `npm run serve` serves it on localhost:8080.

The published site is password protected. GitHub Pages can't check a password on a server, so the build script encrypts the whole app with the password (AES-256-GCM, key from PBKDF2) and the login page decrypts it in the browser:

    SITE_PASSWORD='...' npm run deploy:pages

That pushes a `gh-pages` branch containing only the login page and the encrypted app. In the repository settings, set Pages to deploy from that branch. Run the command again to update the site or change the password.

The encrypted file is public, so a short or guessable password can be cracked offline. The build refuses passwords under 12 characters unless `ALLOW_SHORT_PASSWORD=1` is set.

## How it works

Each captured word is cut into letters along the pen path, so joins and loops stay attached to the right letter. To write new text it picks from your recorded letters (reusing real letter pairs when it has them), joins them with smooth curves and adds a little drift so the result doesn't look copy-pasted.

The Sheet tab does the same job as the script in `tools/` (writing text or math in your hand onto a PDF, see `CLAUDE.md`), but from the browser, by dragging boxes onto the page.

The code is in `src/`: `align.js` cuts words into letters, `synth.js` chooses and joins them, `math.js` lays out math, `render.js` draws the ink, `capture.js` is the pad, and `sheet.js` and `sheetui.js` are the Sheet tab.

## Tests

    npm test
    npm run e2e              (needs Playwright)
    npm run e2e:protected

The tests use a fake pen that writes cursive and print with jitter and slant.
