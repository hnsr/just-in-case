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
- Add a **Cable duct** in the object tree to hold a round cable. Place it on an enclosure surface or nest it under another object and set its Z offset relative to that object’s origin. **Base height** is the thickness below the cable seat. Use the cable-center readout to align with a wall cutout and **Push-in fit** to adjust the grip of the staggered teeth.
- **Screw-fastened enclosures** have a flat lid and four screw bosses joined to the base walls. Two diagonal collars seat in a round recess and a slotted recess in the lid. Adjust the locator fit and screw sizes under **Screw closure**. Set counterbore depth to 0 for plain lid holes.
- **PCB corner mount** adds four seats with L-shaped walls around the board. Set the board dimensions and base height, then position and rotate all four corners together. In **Screw** mode, measure each hole inset from the board edge to its center. The app sizes the seats automatically and leaves 1 mm of material beneath each pilot hole. **Snap-fit** uses four solid catches with a default overhang of 0.2 mm. Tuck one edge under two catches, then press the opposite edge down. Set the corner seat size and clip overhang to suit the board.
- **Geometry** adds or cuts a box, cylinder, or sphere on its parent. Set **Copies** above 1 to repeat the shape with a step and rotation per copy. Child objects use the Geometry object’s origin.
- In a Geometry object's **Properties**, check **Reference only** to preview the branch as translucent shapes. References can float or overlap the enclosure and stay out of the STL. Use the eye next to any object to hide or show its branch in the preview.
- Use **Top**, **Front**, or **Side** to check alignment in a fixed, translucent view. Pair any of these with **Assembled** to see where the base and lid line up.
- **Child placement** starts at the center of the chosen part’s interior floor or ceiling. X, Y, and Z follow that part’s print orientation. Nested children use the position and rotation of their parent.
- **Export STL** downloads either part or both parts side by side with an 8 mm gap. Each part exports with its outside face on the print bed. The same options are in the enclosure row’s **More actions** menu.
- Choose a **mounting sample** in the **Export STL** menu to print the objects attached to that floor or ceiling together on a cropped patch at the original thickness. The sample preserves their spacing and includes cuts through the patch.
- To print a fit sample, choose **Export STL** from an additive object's **More actions** menu. An object sample includes its descendants and their cuts, excluding reference geometry. The sample keeps its print orientation and rests on the print bed at its lowest point.
- Choose **Export fit sample** on a wall cutout card to print the opening and a short section of wall around it. The sample includes the floor or ceiling when close to the opening. Cutouts spanning the split seam export two pieces side by side with the mating lip.

The editor autosaves the last valid project in this browser. **Save JSON** and **Open JSON** let you keep and share editable designs in the current format. When the format version changes, the editor starts with the example and saves it under the new version.
