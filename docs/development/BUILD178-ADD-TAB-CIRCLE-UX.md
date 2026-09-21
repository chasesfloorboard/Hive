# Build 178 — Add Tab Circle UX

## Changes

- Replaced the accent-colored Add Tab rectangle with a compact 34px circular control.
- Kept the Add Tab control neutral at rest and on hover so it no longer competes visually with active tabs.
- Changed the pressed state from pure black to the shared darker control surface with an inset shadow and subtle downward movement.
- Preserved the existing `#tab-add-btn` identity and tab-creation behavior.

## Validation

- Build 178 Add Tab regression tests: 2/2 passed.
- Full suite and static checks to be run before packaging.
- No GUI runtime validation was available in this build environment.
