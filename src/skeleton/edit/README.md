# Layer-facing spatial skeleton editing

`src/skeleton/edit/` joins the generic edit queue in `src/skeleton/edit_queue/`
to one segmentation layer.

- `edit_queue/` decides what happens to an edit: its order, its preview, the
  undo history, stable IDs and the requests to the server. It imports no
  layer, no rendering code and no datasource. eslint stops it from importing
  `src/datasource`.
- `edit/` decides what the user sees and does: the edit modes of a layer, the
  display of confirmed skeletons and previews, the pending edit markers, and
  the message for a failed action. It also downloads the complete skeletons
  that an edit needs.

Code that needs the layer, the render layer or the user belongs in `edit/`.
All other edit code belongs in `edit_queue/`.

Complete skeletons have code on both sides. The model and its deltas are in
`edit_queue/`, because the preview applies them. The cache is in `edit/`,
because it downloads under the layer's limits and also serves the display.
The cache builds the model directly. The port in `edit_queue/queue_input.ts`
only says which complete skeletons an intent needs and pins them while it
runs.

`edit_queue/README.md` describes the architecture and defines its terms.
