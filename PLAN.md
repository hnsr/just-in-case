# Just in Case

A web-based tool for creating fully parameterized 3D printable enclosures for (for example) electronics projects.

By limiting the scope of the tool to designing enclosures, we can avoid having to generelize too much, and we can make it easier for users not familiar with CAD design to quickly design an enclosure for their projects.

It should work entirely by parameterisation, and provide a live preview of the model resulting from the given parameters. The 3D model should be downloadable as an STL file.

Projects should be saved as plain JSON files that can be either saved in local storage, or downloaded for later importing.

## Object hierarchy

A project consists of a hierarchy of objects, with the root object always being the actual case itself.

Objects are of a type, and each object has:

- Properties: some arbitrary properties the influence the how the object's main shape is generated and what parameters and features are available
- Parameters: the basic dimensional parameters of the object
- Features: type-specific, optional modifications that can be instantiated and positioned onto anchor points/surfaces of the main object
    - Features can have their own parameters and properties
- Child objects: these are their own objects but positioned relative to their parent object

Each type implementation takes the above as an input to generate the model.

Only enclosures can be at the root of the hierarchy, which are a special type that always expose a 'base' part and some other part (lid, upper half), which can be viewed (in the live preview) in an exploded view or toggled, and can exported (in the correct printing orientation) either together or separately.

TODO: Should we more precisely define the special enclosure type and how the splitting into base and other parts is done?
TODO: Should an object (or at least enclosure) also expose anchoring primitives to anchor child objects to?

### Object properties

Properties are arbitrary type-specific inputs that define how the base object is structured. It influences which parameters and features are available for the object.

Properties must be set on instantiation, as changing them is a potentially 'lossy' operation, since the available parameters, features and anchor primitives might change.

For an enclosure object type an option could be 'Do not include lid' (boolean)

TODO: Consider removing the properties concept due to the complexity it introduces, just create a new type instead if it's a different kind of object?

### Object parameters

Parameters define dimensional parameters of an object, such as width, height, depth, thickness, tolerances, and so on.

A paremeter can be given as a formula, in which it's possible to refer to user-defined global project variables.

A special parameter type is a geometric primitive (sphere, cylinder, box), used for types which (for example) generate geometry based on such a primitive.

### Object features

Features are type-specific modifiations that a type implementation exposes. Examples are cable exit holes.

They differ from properties in that they can optionally be defined in zero ore more instances, with each instance having its own set of parameters.

The type implementation can either fully take responsibility of feature placement, or expose placement options onto anchoring primitives:
- Fixed points
- Line segments
- Bounded surfaces

### Feature parameters

These are similar to object parameters and define the dimensional properties of a feature

Example: the diameter of a cable exit hole.

----

## Included object types

This is a description of object types that should be included with the application

### Split enclosure (root object)

This is an enclosure that is split in a top and bottom part.

TODO: Define properties/feats/anchoring primitives

### Lidded enclosure (root object)

This is an enclosure that has a base and lid part.

TODO: Define properties/feats/anchoring primitives

### PCB press-fit mounts

TODO: Define properties/feats

### Geometry repeater

This is a simple geometry repeater, which takes a geometry primitive parameter plus some offset, rotation (or maybe we need a transform parmeter type?) and a repeat count to generate multiple copies of the primitive.

----


## UI/UX

The object hierarchy should be shown on a side-panel on the left hand side. From there, parameters, properties, features and child objects for each object can be defined. A live preview is shown on the right.


## Future features to consider
- Layer height optimisation
- Sparse export: a rendering of the model with as little volume/material as possible, for doing test prints to check dimensions and tolerances


