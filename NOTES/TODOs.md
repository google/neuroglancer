# TODO List

- FOR TOMORROW: start to prepare the problematic/email to JMS + fix the issue with the preview not rendering on empty chunks + add label management back

- Fix the orientation of the disk in the brush tool
- Add support for flood fill on different planes
-? adapt the brush size to the zoom level linearly
- rework the ui (tabs)
- add shortcuts for tools (switching tools, toogle erase mode, select label from the pointed one in the slice view and adjusting brush size) and label creation
- the flood fill sometimes leaves artifacts in sharp areas
- rework the autocomplete for the ssa+https source.
- fix the flood fill for compressed chunks
- rework the drawing preview for compressed chunk (see applyLocalEdits())
- optimize flood fill tool (it is too slow on area containing uncached chunks, due to the getEnsuredValueAt() calls)

- rework vox backend
- rework label handling


## mail

Hey, I am writting a mail for Jeremy Maitin-Shepard, the creator of neuroglancer, to present him the voxel annotation layer and get his opinion on the architecture and design choices before I start to consolate the code. Can you help me write it? Here is a draft of the mail:

Hello,

...intro
I am currently working on a voxel annotation layer for neuroglancer as part of my internship at Ariadne.ai. The goal is to allow users to annotate volumetric data directly within the neuroglancer interface, with the objective in the end to realize labeling for deep learning. I saw that you mentioned this feature in this talk: https://www.youtube.com/watch?v=_XgfGcu81AA

We made good progress on the feature and have a working prototype, and feel like it is the right time to share it with you, to have your opinion on the architecture and design choices before I start to consilate the code.

Here is how it works: 

We have a new "vox" layer accepting volume data sources [src/layer/vox/index.ts], and we have a brush and a flood fill tool (with an erase mode for both, i.e. label = 0) [src/ui/voxel_annotation.ts]. 

Drawing happens at a set resolution (currently locked at the max resolution), the drawn chunks are the downscaled. Since the resolution is fixed, the max brush size is limited to 64, after what the performances are too poor. I tried to implement an upscaling root too, for this there are two path:
- the first one is to upscale right after drawing, like the downscaling, but we quickly hit limitation on the number of upscale step we can perform (because of the exponential nature of the upscale that the downscale hasn't), I estimate them to be 3 to 4 steps max. This method would allow for higher brush size, but not for giant brush ones.
- an other way is to delay the upscaling to the moment we want to draw the chunk that needs upscaling, I tried this method but we quickly hit some upscaling conflicts issues and this method is also not compatible with the generic data sources, requiring a way to mark chunks as dirty.

The drawing pipeline is handled by the EditController class [src/voxel_annotation/edit_controller.ts & src/voxel_annotation/edit_backend.ts], a shared object, 
