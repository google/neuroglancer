### ☃️ December 2019 ❄️
# Annotation Overhaul: Part 1
* New type of Annotations: Collections
    * Collections are annotation groups.
    * Collections can be created with the new ⚄ button.
    * Two special collections: Line Strip (ʌ) and Spoke (⚹).
        * Line Strip connects multiple lines together.
        * Spoke connects multiple lines to a single point like the spokes of a wheel.
        * By right clicking the the ʌ/⚹ button, the annotation will automatically connect the segments together.
            * Right clicking the ʌ button will connect the end of the Line Strip to the beginning.
            * Right clicking the ⚹ button will connect every line to the previously made line.
    * Collections can be completed via Ctrl+Double Click or by clicking the button again.
    * Right clicking a collection in list view will show/hide its children.
    * **Collections have all the tags and segments of their children.**
* Annotation Grouping
    * Hold ctrl while clicking an annotation in list view will allow you to select multiple annotations at once.
    * The ⚄ button will group these annotations together into a collection.
        * Note: The first selected annotation in the group will determine where the group will be created. For example, if many annotations are selected but the first one is already part of a parent collection, the new collection will be a child of that same parent.
    * The 💥 button will remove all child annotations from a collection and relocate them to the parent of that collection.
        * **Note: Collections CANNOT be empty, so this will delete the collection.**
    * The ✂️ button will remove the selected annotation(s) from its parent collection.
* Import CSV
    * Import Exported CSVs to the current layer.
    * CSVs can be generated or converted from other sources as long as they have the same format as exported CSVs.
    * **Note: Imported CSVs are not unique, importing the same CSV to one layer multiple times will result in duplicates.**
    * **Linked Segmentations are not preserved**
