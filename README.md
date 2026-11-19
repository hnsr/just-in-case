# Just in Case

A browser-based parametric enclosure designer for 3D-printed electronics projects. It opens with an editable example.

## Run locally

Use Node.js 22.12 or later.

```sh
npm ci
npm run dev
```

Open the local URL Vite prints. Run `npm test` to check the geometry and project format, or `npm run build` to generate a static site in `dist/`.

## Design and print

- **Body and lid** control the outside dimensions, wall and floor thickness, corner radius, and inset lip. All measurements use millimetres.
- **Cutouts** support rectangles and circles on all four walls. The offset is measured from the wall midpoint and the vertical position from the bottom of the base.
- **Mounting** adds four PCB posts with blind pilot holes.
- **Export STL** downloads the base, lid, or both arranged side by side with an 8 mm gap. The base exports upright and the lid exports with its outside face on the print bed.
- The editor autosaves the last valid project in this browser. **Save JSON** and **Open JSON** move an editable project between browsers or keep multiple designs as files.
