# Just in Case

A browser-based parametric enclosure designer for 3D-printed electronics projects. It opens with an editable example.

[Open Just in Case](https://hnsr.github.io/just-in-case/)

## Run locally

Use Node.js 22.12 or later.

```sh
npm ci
npm run dev
```

Open the local URL Vite prints. Run `npm test` to check the geometry and project format, or `npm run build` to generate a static site in `dist/`.

## Design and print

Use **Change enclosure** to choose a lidded, base-only, or split case. Confirming the change resets the current project, so use **Save JSON** first if you want to keep it. Select an object in the left-hand tree to edit it and highlight its surfaces in the preview. Use **+** on a row to add a child or the trash icon to remove the object.

- Open **Variables** beside the project name to edit project-wide numbers and formulas. Use a name like `boardWidth` in a field such as `boardWidth + 16`. Formulas support parentheses and the operators `+`, `-`, `*`, `/`, `%`, and `^`. Dimensions are in millimetres and rotations are in degrees.
- **Features** include wall cutouts and four screw posts. Cutouts can cross the seam on a split enclosure. Their offsets start at the midpoint of the chosen wall and their heights are measured from the bottom of the enclosure.
- **PCB press-fit mounts** add four clips to support and grip the edges of a board. Size the clips to your board and printer tolerances.
- **Geometry repeaters** add or cut a pattern of boxes, cylinders, or spheres. Each copy can shift and rotate along three axes. Children of a repeater use the pattern’s origin.
- **Child placement** starts at the center of the chosen part’s interior floor or ceiling. X, Y, and Z follow that part’s print orientation. Nested children use the position and rotation of their parent.
- **Export STL** downloads either part or both parts side by side with an 8 mm gap. Each part exports with its outside face on the print bed.

The editor autosaves the last valid project in this browser. **Save JSON** and **Open JSON** let you keep and share editable designs. Version 1 files and browser saves are migrated when opened.
