# Fluxerly.js website and docs

Read this before changing anything visual. Then run the check, it knows more than this page. [Documentation maintenance](/docs/DOCUMENTATION.md) covers generation, published versions and deployment

## Keep

The site's character is not open for restyling without the owner asking:

- The mascot, the sky and water hero, the painted icon family and the far and near depth layers
- The signal line with its numbered stations
- The Motion and Still modes, and the one time spotlight on the switch for a first visit
- The conductor's living face and its black hole, and the icons that move part by part (`scripts/icon-parts/parts.json`)
- The cyan, violet and gold palette and the Outfit typeface

## Use the shared values

They are named once, at the top of `src/styles/global.css`

- Sizes: `--type-*`
- Weights: `--weight-*`
- Corners: `--corner-*`, with `corner-shape: squircle` on all but the round one. An inner corner is the outer corner less the gap between them
- Speeds: `--speed-*`
- Colors: `--color-*`. Colors inside art stay in the art

`tests/style-rules.test.ts` fails on a raw value. Add a new shared value only when none fits, not to make a test pass

## Other rules

- Titles, headings, nav and buttons are in Title Case, from `src/lib/title-case.ts`. Sentences are not
- One main button per view
- Touch targets are 44 px. Use a clear layer around a control where it can't grow
- One icon library, Phosphor. The painted icons are art with a meaning, placed where the meaning fits
- No tooltips unless asked for
- Avoid hard numbers that drift, such as test totals
- A failure tells the reader in plain words and logs the real reason. Nothing fails silently
- Every screen in `scripts/checks/lib.mjs` must work, portrait and landscape, phones to ultrawide

## Before you finish

| Command | When |
| --- | --- |
| `node scripts/checks/look.mjs <path> <out.png> <width>x<height> <selectors>` | After each change, a few seconds, with a site already running at `LOOK_URL` or `http://localhost:4321` |
| `pnpm check:ui --changed` | During work, after a round of changes. Checks only the parts and pages the changed files can reach |
| `pnpm check:ui` | Once a round of changes is done. Must pass |
| `pnpm check:ui --quick` | A shorter run on a few screens of each kind, when you want one. Nothing runs by itself |

`pnpm check:ui` clears Astro's content cache, then runs the type check, a build, the tests and every screen

## Motion

Every page should feel captivating and immersive, the docs calmer, and reading always comes first. Move only transforms and opacity, follow the page's scroll with scroll timelines where you can, and switch everything off under `html[data-still]`. Still stops everything that moves. A fade that only changes opacity in place, such as the mascot's preview sharpening into the full picture, may stay. `html[data-still]` already counts reduced motion when no choice is saved, and a media query would overrule a visitor's saved choice. Shared effects live in `src/styles/immersion.css`

## Visual changes

Have two independent reviewers score fixed screens out of 10 and add the round to `scripts/checks/design-scores.json`. A reviewer's fall of more than 0.2 from the immediately preceding round fails the test when that reviewer appears in both rounds, so fix it rather than editing the log

Look at the rendered screens yourself as well. Measurements passed while a section's rail was missing from one mode, and only the pictures showed it
