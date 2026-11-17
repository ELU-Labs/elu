# The README's animations

Each animation in the README is drawn from a story.
A story is a few captured screens of the ELU terminal app, with a caption each.
`render.mjs` turns a story into one looping SVG file.

What is here:

- `stories/<slug>/`: the ten stories. Each holds `story.json` and one `.ansi` file per frame.
- `render.mjs` writes the animation, and one still SVG per frame if you ask.
- `check.mjs` reads an animation and checks its timing and what it holds.
- `shoot.mjs` takes pictures of an SVG in a headless Chromium.

The three scripts need Node 22 and nothing else. `shoot.mjs` also needs a Chromium.
The animations are in `docs/media/<slug>.svg`. None of this ships in the npm package.

## Draw them again

From the root of the repository. One story:

```
node tools/readme-animations/render.mjs tools/readme-animations/stories/reply docs/media/reply.svg
```

All ten:

```
for d in tools/readme-animations/stories/*/; do s=$(basename "$d"); node tools/readme-animations/render.mjs "$d" "docs/media/$s.svg" || break; done
```

The same story always gives the same file, byte for byte.

```
node render.mjs <story folder> <out.svg> [--stills <folder>] [--width <px>]
```

It prints one line: the frames, the loop length, how many different rows it wrote, the size.
With `--stills` it also writes `<folder>/reply-01.svg`, `<folder>/reply-02.svg`, ... These are plain, not animated. They are for looking at. Do not keep them in the repository.
`--width` is the width the picture has in the README, in pixels. The default is 830, about the width of the README column on the repo's front page.

It stops with a message when a capture has more lines than `rows`, or a line wider than `cols`.
It warns when a capture has fewer lines than `rows`, when a caption is longer than 60 characters, and when a `01.txt` beside `01.ansi` does not hold the same text.

## After the app changes

1. Run the app in tmux at the story's size (100 columns, 30 rows), in a made-up project. Nothing on the screen may be real: no real name, account, e-mail, host or path. Made-up e-mail addresses end in `.invalid` or `example.com`.
2. At each moment of the story, save the screen: `tmux capture-pane -e -p > 01.ansi`. Save `tmux capture-pane -p > 01.txt` too and read it. Keep the `.txt` files out of the repository.
3. Put the `.ansi` files in the story's folder and set the captions in `story.json`.
4. Render, check, and look at every frame (see below).
5. Use the story's `alt` as the image's alt text in the README, and make the line above the image say what the animation shows.

## The story format

One folder per feature, named by its slug, holding:

- `story.json`
- `01.ansi`, `02.ansi`, ...: each is exactly what `tmux capture-pane -e -p` printed for the app's pane, one whole screen of `cols` x `rows`.

```json
{
  "slug": "reply",
  "alt": "One sentence saying what the animation shows.",
  "cols": 100,
  "rows": 30,
  "top": 0,
  "show": 30,
  "still": 4,
  "frames": [
    { "file": "01.ansi", "seconds": 2.5, "caption": "What is happening, at most 60 characters" },
    { "file": "02.ansi", "seconds": 3, "caption": "The next step" }
  ]
}
```

- `alt` becomes the `<title>` of the SVG. Use the same sentence as the image's alt text in the README.
- `top` is the first screen row to show, counted from 0. `show` is how many rows to show. They cut rows only. The full width always shows. Left out, they mean the whole screen.
- `still` is the frame, counted from 1, that shows alone when the viewer asked for reduced motion or cannot animate. Left out, it is 1.
- `seconds` is how long a frame shows. The loop is as long as the sum.

## In the README

```
![One sentence saying what the animation shows.](docs/media/reply.svg)
```

The file animates with CSS inside its own `<style>`. It has no script, no SMIL, no foreignObject, no outside file and no outside font, so it plays where GitHub serves it under a policy that allows inline styles only.

## What the picture is

- A dark card with rounded corners and a thin edge, so it reads on a light page and on a dark page.
- The screen, cell for cell: text, foreground and background colour, bold, dim, italic, underline, strike and reverse, in 16 colours, 256 colours and true colour.
- Under the screen, the frame's caption and one dot per frame. The bright dot is the frame that shows.
- At 100 columns the text is about 13 px high when the picture is 830 px wide. At 140 columns it is about 9.5 px, which is small. Keep stories near 100 columns.

How the grid holds with any font:

- Every run of plain ASCII text starts at its column and has its length fixed with `textLength`. A run never holds two spaces in a row and never starts or ends with a space.
- Every other character sits alone in its own cell, centred. A wider glyph cannot push its neighbours.
- Box-drawing lines, block characters, braille dots and the common shapes are drawn as shapes, not taken from a font:
  - lines: light and heavy lines, corners, tees and crosses, half lines, dashed lines, round corners, slants, and the double line as a straight line or a corner;
  - blocks: all of `▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕` and the quadrants;
  - braille: every pattern, on an even grid, so braille charts come out clean;
  - shapes: `◆◇■□▪▫●○◉•▲▼▶◀▴▾▸◂△▽▷◁▵▿▹◃←↑→↓✓✔✗✘✕✖✚`.
- All the lines of one frame are one shape for each colour and weight, so borders join across rows.

The 16 basic colours:

```
black   #3a3a3a   red     #ff5f5f   green   #5fd787   yellow  #ffd75f
blue    #5fafff   magenta #af87ff   cyan    #5fd7d7   white   #c6c6c6
bright: #767676   #ff8787   #87ffaf   #ffff87   #87d7ff   #d7afff   #87ffff   #ffffff
```

Text with no colour is `#d0d0d0`. The card, and a cell with no background, is `#0d0e11`.
Black is a grey so that black text still shows on the card. Used as a background it is a grey block.

How it stays small: a row of the screen is written once and used by every frame that shows the same row. So are the lines of a frame.

## What a story author must know

- tmux drops the spaces at the end of each line. The tool gives the rest of the line the background colour that was in effect at the end of the line. That is what a full-screen app painted there. If a line must end in the plain background, the capture must say so (it does when the app reset the colour before the end).
- All frames of a story have the same `cols` and `rows`.
- Characters left to the viewer's font: any character outside ASCII that is not in the lists above, for example `· … › ≥ ℹ`. They stay in their cell, but their look depends on the font.
- Avoid emoji. They take two cells and their look changes from one computer to the next.
- Left to the font, so they may not join their neighbours: box characters that mix single and double lines (`╒ ╞ ╪` ...) and double-line tees and crosses (`╠ ╦ ╬` ...).
- Not drawn: blink, overline, hidden text, and underline styles and colours (an underline is always one straight line in the text colour).
- A caption longer than 60 characters can run under the dots.

## Check an animation

```
node tools/readme-animations/check.mjs docs/media/reply.svg tools/readme-animations/stories/reply
python3 -c 'import sys, xml.dom.minidom as m; m.parse(sys.argv[1]); print("well-formed")' docs/media/reply.svg
```

`check.mjs` prints one line per check and ends with the size. It fails when:

- the file holds a script, SMIL, foreignObject, an outside link or an outside image;
- at any moment of the loop more or fewer than one frame shows;
- a frame does not show for its own seconds, or the loop is not the sum of the seconds;
- the reduced-motion rule does not leave only the still frame;
- a caption or the title differs from the story;
- the text holds a machine path, or an e-mail that does not end in `.invalid` or `example.com`.

It does not look for names of people, hosts or customers. Read the screens for that.

## Look at every frame

Render with `--stills` into a folder outside the repository, then turn each still into a PNG and look at it.

With resvg (fetched by npx on first use), 1660 px wide, twice the README width:

```
npx -y @resvg/resvg-js-cli --fit-width 1660 --font-default-family "DejaVu Sans" stills/reply-01.svg png/reply-01.png
```

With Chromium, the way a README shows it (an `<img>` 830 px wide, served with the policy GitHub uses for raw SVG files):

```
node tools/readme-animations/shoot.mjs "$CHROME" stills/reply-01.svg png --scale 2
```

`$CHROME` is the path of a headless Chromium, for example the `chrome-headless-shell` that Playwright keeps under `~/.cache/ms-playwright/`.

More of `shoot.mjs`:

```
node tools/readme-animations/shoot.mjs "$CHROME" docs/media/reply.svg png --at 1.2,4          # the animation, 1.2 s and 4 s after it loaded
node tools/readme-animations/shoot.mjs "$CHROME" docs/media/reply.svg png --at 4 --bg '#0d1117'   # on GitHub's dark page colour
node tools/readme-animations/shoot.mjs "$CHROME" docs/media/reply.svg png --at 1.2 --reduced  # with reduced motion: the still frame
node tools/readme-animations/shoot.mjs "$CHROME" docs/media/reply.svg png --timeline          # no picture: steps the loop every 10 ms and prints which frame shows
node tools/readme-animations/shoot.mjs "$CHROME" stills/reply-01.svg png --scale 4 --clip 20,20,420,300   # a close look at one part
```

The ten animations were drawn and looked at on Linux, where Chromium took Liberation Mono for the screen and the system sans font for the caption.
