### October 21 2019
# Lock layers to ignore interactions
* In the Segment Selection widget, the "Ignore segment interactions" checkbox will lock a layer so that it will ignore selection, split, and merge operations.
* This can be used for more easily editing multiple layers at once.

# Decrease lag from multiple annotations
* Previously, having many annotations (1000+) would cause editing and rotating the 3D view to be slow.
* This change uses a virtual list to hide annotation information that is offscreen. All functionality should be the same, just with better performance.
