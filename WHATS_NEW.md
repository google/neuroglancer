### 🌴 July 2019 ☀️
# New Annotation Controls
* Shift + Click
    * Select a continous section of annotations between the previous selection and current selection.
    * Cannot select annotations of different hierarchy levels i.e annotations inside a collection with those outside that collection.
    * Will deselect annotations that are already selected.
* Ctrl + Click
    * Works the same as before for selecting.
    * **Will now deselect annotations that are already selected.**
* Collection Editing
    * Activate edit mode for an existing Collection via the "📝" button.
    * Add annotations in edit mode by pressing the "➕" button.
    * Spoke annotations can be edited. Added annotations will be transformed into points that connect with the center.
    * LineStrip annotations cannot be edited.
* Generate Spoke and LineStrip from existing annotations.
    * Uses existing annotations as positions/points in generated collection.
    * With multiple annotations selected press "ʌ" for a LineStrip and "⚹" for a spoke.
    * **This will not delete the originally selected annotations.**
    * To **delete the source annotations**, uncheck "Preserve Source Annotations" in User Preferences.
* Generate Point(s) from selected annotation.
    * Press "⚬" to reduce a given annotation to its component points.
    * Line and Bounding Box annotations reduce into their endpoints.
    * All other two-step annotations reduce into their center point.
    * Collection annotations reduce their child annotations.
    * Special collections **remove overlapping point annotations**.
    * **Cannot reduce the children of special collections.**
* First annotation in a selection is now animated.
* 🌐 Ellipsoid annotations are fixed. 👀
