// Used when compiling wasm module.
mergeInto(LibraryManager.library, {
  neuroglancer_draco_receive_decoded_mesh: (...args) => {
    alert(args);
  },
});
