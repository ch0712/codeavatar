# codeavatar-runtime

**Put a face that speaks and shows expression into your own page.** Give it a character file
and a set of expression numbers; it returns one SVG frame. Use it for a talking head on a
web page, a batch of frames for narrated video, or a face that reacts inside an Agent reply.
Change one number and the face changes — no redrawing, no re-recording.

```js
import { renderFaceSvg, NEUTRAL, VISEME } from 'codeavatar-runtime';

const pose = { ...NEUTRAL, ...VISEME.A };
document.querySelector('#stage').innerHTML =
  renderFaceSvg(charJson, pose, { transparentBg: true, idPrefix: 'a1' });
```

**[Live demo](https://codeavatar-runtime-demo.app.workbuddy.host/?sharecode=4PW2T4UUBH)** ·
[Single-file demo source](https://github.com/ch0712/codeavatar/blob/master/demo/runtime.html)

## Install

> **Status**: this package is built and verified but **not yet published to npm**.
> Until then, from the [repository](https://github.com/ch0712/codeavatar):

```bash
npm pack ./packages/avatar-runtime
npm i ./codeavatar-runtime-0.2.0.tgz
```

Or skip installation entirely and use the CDN build:

```html
<script src="https://cdn.jsdelivr.net/gh/ch0712/codeavatar@master/packages/avatar-runtime/dist/standalone.js"></script>
<script>
  const svg = CodeAvatar.renderFaceSvg(CHAR, {
    ...CodeAvatar.NEUTRAL, ...CodeAvatar.VISEME.O
  });
  document.querySelector('#stage').innerHTML = svg;
</script>
```

Three builds ship in `dist/`: `index.mjs` (ESM), `index.cjs` (CJS), `standalone.js`
(IIFE → `window.CodeAvatar`). All three render byte-identical SVG.

## API

| Export | Signature | Purpose |
|:--|:--|:--|
| `renderFaceSvg` | `(data, pose, opts?) => string` | Render one frame to an SVG string |
| `renderFaceFrames` | `(data, poses[], opts?) => string[]` | Render a performance to a frame array |
| `uniquifySvgIds` | `(svg, prefix) => string` | Rename `id` / `url(#id)` pairs |
| `NEUTRAL`, `VISEME`, `MOODS`, `POSE_RANGES` | numeric contracts | 15 pose channels / 6 visemes / 5 moods |

`opts`: `transparentBg` (omit the background rect), `depth` (2.5D prototype,
default = flat path), `idPrefix` (**required when several SVGs share one page** —
clipPath / mask ids are document-scoped).

Types are in `dist/index.d.ts`. `renderFaceSvg` is a pure function:
same input → byte-identical output, every time.

## Where does `charJson` come from?

**This package intentionally ships no character data.** Character artwork
(`chars/*.json`, reference sheets) is *not* MIT-licensed — see
[`docs/LICENSES.md`](https://github.com/ch0712/codeavatar/blob/master/docs/LICENSES.md) —
and therefore cannot be redistributed inside an MIT package.

Generate your own from a flat illustration you drew:

```bash
python tools/codeavatar.py build my-sheet.png mychar
# → packages/anchor-core/src/chars/mychar.json
```

The resulting JSON is yours. Pass it as `data`; the runtime needs nothing else.

## Implementation notes (not a capability limit)

Today the renderer is a React component server-rendered into an SVG string, so a character
fits in a static page, a CI artifact, or an Agent response without standing up a service.
That is the current implementation choice, **not a constraint on the product**: if a heavier
stack makes the picture better, it can be used. We do not cut resources for their own sake —
we care about the result.

The renderer is **not duplicated** in this package — it is bundled from
`packages/anchor-core/src/FaceTraced.tsx`, the single source of truth, so a character looks
the same in video and on a web page.

Visual equivalence with the video pipeline is enforced by
`tools/runtime_parity_check.py` (pixel-identical six-viseme grid) and
`scripts/verify.mjs` in this package (byte-identical frames across all three builds).

Full docs: [README](https://github.com/ch0712/codeavatar/blob/master/README.md) ·
[Integration guide](https://github.com/ch0712/codeavatar/blob/master/docs/INTEGRATION.md)

## License

MIT. Character artwork and third-party dependencies are **not** covered — see above.
