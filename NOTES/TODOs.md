# TODO List
- connect front and backend (see [data-saving-plan.md](../NOTES/data-saving-plan.md))
- optimize drawing tools (they are really responsive rn)
- add color picker
- create persistant storage (e.g. via a server or look into IndexedDB) (see [data-saving-plan.md](../NOTES/data-saving-plan.md))
- Fix the orientation of the disk in the brush tool 


# Questions
- do we really need a frontend buffer? Should this buffer be a simple list of pixels and passed to the shader outside of the chunking system, this would let the chunking behaviour be managed by the backend? 
- should the backend contians the full map or should it just contain the displayed and surrounding chunks and retrieve the rest live from the datasource (this is a yes for me)
