## Just in Case

A web-based tool for creating fully parameterized 3D printable enclosures for (for example) DIY electronics projects.

By limiting the scope of the tool to designing enclosures, we can avoid having to generelize too much, and we can make it easier for users not familiar with CAD design to quickly design an enclosure for their projects.

It should work entirely by parameterisation, and provide a live preview of the model resulting from the given parameters. The 3D model should be downloadable as an STL file.

Projects should be saved as plain JSON files that can be either saved in local storage, or downloaded for later importing.

## Object hierarchy

TODO: Describe object hierarchy, and how defining parts and features works. Some thoughts:

A project consists of a hierarchy of objects (parts and features), with the root object being the actual case itself. Parts can be added relative to the case. Features can be things like cable exit holes, screw holes are ducts. Parts can be things like a 'bed' to house a printed circuit board, or a duct for cable strain relief.

Which features are available on an object is a property of the object type they are defined on (i.e. a case supports cable exit holes). Feature placement and instantiation is done in coordination with the parent object type.

Parts are more separate from the parent object, but can be positioned relative to anchor points that are exposed by parent objects.

Custom objects are parts that are procedurally generated using basic shapes

## Enclosure root object

### Enclosure type

### Enclosure features

## Parts

## Custom objects

## UI/UX

The object hierarchy should be shown on a side-panel on the left hand side. From there, parameters for each object can be set

## Additional features

- Live preview: explosion view, lower or uppper half view
- Sparse export: a rendering of the model with as little volume/material as possible, for testing dimensions and tolerances


