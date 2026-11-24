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

Use **Change enclosure** to choose a lidded, base-only, screw-fastened, or split case. Confirming the change resets the current project, so use **Save JSON** first if you want to keep it. Select an object in the left-hand tree to edit it and highlight its surfaces in the preview. Selecting a cutter also shows its full shape as a dashed outline. Use **+** on a row to add a child, or open its **More actions** menu to remove the object.

- Open **Variables** beside the project name to edit project-wide numbers and formulas. Use a name like `boardWidth` in a field such as `boardWidth + 16`. Formulas support parentheses and the operators `+`, `-`, `*`, `/`, `%`, and `^`. Dimensions are in millimetres and rotations are in degrees.
- Focus a field containing a plain number and scroll up or down to adjust it by one. Hold **Shift** for 0.1-unit steps in fields that allow decimals.
- **Wall cutouts** are positioned from the midpoint of the chosen wall and the bottom of the enclosure. In a split enclosure, choose **At split seam** to center the opening on the seam and open the lip so the halves can close around a cable.
- Add a **Cable duct** under **Features** for each round cable you want to press into the case. **Base height** measures from the inside floor to the cable seat. Use the cable-center readout to align with a wall cutout. The staggered teeth span the duct and lean inward near the top to hold the cable down. Choose **Push-in fit** to adjust their grip.
- **Screw-fastened enclosures** have a flat lid and four screw bosses joined to the base walls. Two diagonal collars seat in a round recess and a slotted recess in the lid. Adjust the locator fit and screw sizes under **Screw closure**. Set counterbore depth to 0 for plain lid holes.
- **PCB screw mounts** add four posts with blind pilot holes. Set the board's X and Y hole spacing, then position and rotate the pattern as a child object. Add a separate mount for each board.
- **PCB press-fit mounts** add four clips to support and grip the edges of a board. Size the clips to your board and printer tolerances.
- **Geometry** adds or cuts a box, cylinder, or sphere on its parent. Set **Copies** above 1 to repeat the shape with a step and rotation per copy. Child objects use the Geometry object’s origin.
- In a Geometry object's **Properties**, check **Reference only** to preview the branch as translucent shapes. References can float or overlap the enclosure and stay out of the STL. Use the eye next to any object to hide or show its branch in the preview.
- Use **Top**, **Front**, or **Side** to check alignment in a fixed, translucent view. Pair any of these with **Assembled** to see where the base and lid line up.
- **Child placement** starts at the center of the chosen part’s interior floor or ceiling. X, Y, and Z follow that part’s print orientation. Nested children use the position and rotation of their parent.
- **Export STL** downloads either part or both parts side by side with an 8 mm gap. Each part exports with its outside face on the print bed.
- To print a fit sample, choose **Export STL** from an additive object's **More actions** menu or use the export icon on a Cable duct card. An object sample includes its descendants and their cuts, excluding reference geometry. The sample keeps its print orientation and rests on the print bed at its lowest point.

The editor autosaves the last valid project in this browser. **Save JSON** and **Open JSON** let you keep and share editable designs. Version 1 files and browser saves are migrated when opened.
