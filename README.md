Neuroglancer: Web-based volumetric data visualization
-----------------------------------------------------

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![PyPI](https://img.shields.io/pypi/v/neuroglancer)](https://pypi.org/project/neuroglancer)
![Build](https://github.com/google/neuroglancer/workflows/Build/badge.svg)
[![DOI](https://zenodo.org/badge/59798355.svg)](https://zenodo.org/badge/latestdoi/59798355)

Neuroglancer is a WebGL-based viewer for volumetric data.  It is capable of displaying arbitrary (non axis-aligned) cross-sectional views of volumetric data, as well as 3-D meshes and line-segment based models (skeletons).

This is not an official Google product.

# Examples

A live demo is hosted at <https://neuroglancer-demo.appspot.com>.  (The prior link opens the viewer without any preloaded dataset.)  Use the viewer links below to open the viewer preloaded with an example dataset.

The four-pane view consists of 3 orthogonal cross-sectional views as well as a 3-D view (with independent orientation) that displays 3-D models (if available) for the selected objects.  All four views maintain the same center position.  The orientation of the 3 cross-sectional views can also be adjusted, although they maintain a fixed orientation relative to each other.  (Try holding the shift key and either dragging with the left mouse button or pressing an arrow key.)

- [FlyEM Hemibrain](https://www.janelia.org/project-team/flyem/hemibrain) (8x8x8 cubic nanometer resolution). <a href="https://hemibrain-dot-neuroglancer-demo.appspot.com/#!gs://neuroglancer-janelia-flyem-hemibrain/v1.0/neuroglancer_demo_states/base.json" target="_blank">Open viewer</a>

- [FAFB-FFN1 Full Adult Fly Brain Automated Segmentation](https://fafb-ffn1.storage.googleapis.com/landing.html) (4x4x40 cubic nanometer resolution).  <a href="https://neuroglancer-demo.appspot.com/fafb.html#!gs://fafb-ffn1/main_ng.json" target="_blank">Open viewer</a>

- Kasthuri et al., 2014.  Mouse somatosensory cortex (6x6x30 cubic nanometer resolution). <a href="https://neuroglancer-demo.appspot.com/#!{'layers':{'original-image':{'type':'image'_'source':'precomputed://gs://neuroglancer-public-data/kasthuri2011/image'_'visible':false}_'corrected-image':{'type':'image'_'source':'precomputed://gs://neuroglancer-public-data/kasthuri2011/image_color_corrected'}_'ground_truth':{'type':'segmentation'_'source':'precomputed://gs://neuroglancer-public-data/kasthuri2011/ground_truth'_'selectedAlpha':0.63_'notSelectedAlpha':0.14_'segments':['3208'_'4901'_'13'_'4965'_'4651'_'2282'_'3189'_'3758'_'15'_'4027'_'3228'_'444'_'3207'_'3224'_'3710']}}_'navigation':{'pose':{'position':{'voxelSize':[6_6_30]_'voxelCoordinates':[5523.99072265625_8538.9384765625_1198.0423583984375]}}_'zoomFactor':22.573112129999547}_'perspectiveOrientation':[-0.004047565162181854_-0.9566211104393005_-0.2268827110528946_-0.1827099621295929]_'perspectiveZoom':340.35867907175077}" target="_blank">Open viewer.</a>

  This dataset was copied from <https://neurodata.io/data/kasthuri15/> and is made available under the [Open Data Common Attribution License](http://opendatacommons.org/licenses/by/1.0/).  Paper: <a href="http://dx.doi.org/10.1016/j.cell.2015.06.054" target="_blank">Kasthuri, Narayanan, et al.  "Saturated reconstruction of a volume of neocortex." Cell 162.3 (2015): 648-661.</a>
  
- Janelia FlyEM FIB-25.  7-column Drosophila medulla (8x8x8 cubic nanometer resolution).  <a href="https://neuroglancer-demo.appspot.com/#!{'layers':{'image':{'type':'image'_'source':'precomputed://gs://neuroglancer-public-data/flyem_fib-25/image'}_'ground-truth':{'type':'segmentation'_'source':'precomputed://gs://neuroglancer-public-data/flyem_fib-25/ground_truth'_'segments':['21894'_'22060'_'158571'_'24436'_'2515']}}_'navigation':{'pose':{'position':{'voxelSize':[8_8_8]_'voxelCoordinates':[2914.500732421875_3088.243408203125_4045]}}_'zoomFactor':30.09748283999932}_'perspectiveOrientation':[0.3143535554409027_0.8142156600952148_0.4843369424343109_-0.06040262430906296]_'perspectiveZoom':443.63404517712684_'showSlices':false}" target="_blank">Open viewer.</a>

  This dataset was copied from <https://www.janelia.org/project-team/flyem/data-and-software-release>, and is made available under the [Open Data Common Attribution License](http://opendatacommons.org/licenses/by/1.0/).  Paper: <a href="http://dx.doi.org/10.1073/pnas.1509820112" target="_blank">Takemura, Shin-ya et al. "Synaptic Circuits and Their Variations within Different Columns in the Visual System of Drosophila."  Proceedings of the National Academy of Sciences of the United States of America 112.44 (2015): 13711-13716.</a>

# Supported data sources

Neuroglancer itself is purely a client-side program, but it depends on data being accessible via HTTP in a suitable format.  It is designed to easily support many different data sources, and there is existing support for the following data APIs/formats:

- [Neuroglancer precomputed format](src/neuroglancer/datasource/precomputed)
- [N5](src/neuroglancer/datasource/n5)
- [Zarr](src/neuroglancer/datasource/zarr)
- [Python in-memory volumes](python/README.md) (with automatic mesh generation)
- BOSS <https://bossdb.org/>
- DVID <https://github.com/janelia-flyem/dvid>
- Render <https://github.com/saalfeldlab/render>
- Single NIfTI files <https://www.nitrc.org/projects/nifti>

# Supported browsers

- Chrome >= 51
- Firefox >= 46
- Safari >= 15.0

# Keyboard and mouse bindings

For the complete set of bindings, see
[src/neuroglancer/ui/default_input_event_bindings.ts](src/neuroglancer/ui/default_input_event_bindings.ts),
or within Neuroglancer, press `h` or click on the button labeled `?` in the upper right corner.

- Click on a layer name to toggle its visibility.

- Double-click on a layer name to edit its properties.

- Hover over a segmentation layer name to see the current list of objects shown and to access the opacity sliders.

- Hover over an image layer name to access the opacity slider and the text editor for modifying the [rendering code](src/neuroglancer/sliceview/image_layer_rendering.md).

# Troubleshooting

- Neuroglancer doesn't appear to load properly.

  Neuroglancer requires WebGL (2.0) and the `EXT_color_buffer_float` extension.
  
  To troubleshoot, check the developer console, which is accessed by the keyboard shortcut `control-shift-i` in Firefox and Chrome.  If there is a message regarding failure to initialize WebGL, you can take the following steps:
  
  - Chrome
  
    Check `chrome://gpu` to see if your GPU is blacklisted.  There may be a flag you can enable to make it work.
    
  - Firefox

    Check `about:support`.  There may be webgl-related properties in `about:config` that you can change to make it work.  Possible settings:
    - `webgl.disable-fail-if-major-performance-caveat = true`
    - `webgl.force-enabled = true`
    - `webgl.msaa-force = true`
    
- Failure to access a data source.

  As a security measure, browsers will in many prevent a webpage from accessing the true error code associated with a failed HTTP request.  It is therefore often necessary to check the developer tools to see the true cause of any HTTP request error.

  There are several likely causes:
  
  - [Cross-origin resource sharing (CORS)](https://en.wikipedia.org/wiki/Cross-origin_resource_sharing)
  
    Neuroglancer relies on cross-origin requests to retrieve data from third-party servers.  As a security measure, if an appropriate `Access-Control-Allow-Origin` response header is not sent by the server, browsers prevent webpages from accessing any information about the response from a cross-origin request.  In order to make the data accessible to Neuroglancer, you may need to change the cross-origin request sharing (CORS) configuration of the HTTP server.
  
  - Accessing an `http://` resource from a Neuroglancer client hosted at an `https://` URL
    
    As a security measure, recent versions of Chrome and Firefox prohibit webpages hosted at `https://` URLs from issuing requests to `http://` URLs.  As a workaround, you can use a Neuroglancer client hosted at a `http://` URL, e.g. the demo client running at http://neuroglancer-demo.appspot.com, or one running on localhost.  Alternatively, you can start Chrome with the `--disable-web-security` flag, but that should be done only with extreme caution.  (Make sure to use a separate profile, and do not access any untrusted webpages when running with that flag enabled.)
    
# Multi-threaded architecture

In order to maintain a responsive UI and data display even during rapid navigation, work is split between the main UI thread (referred to as the "frontend") and a separate WebWorker thread (referred to as the "backend").  This introduces some complexity due to the fact that current browsers:
 - do not support any form of *shared* memory or standard synchronization mechanism (although they do support relatively efficient *transfers* of typed arrays between threads);
 - require that all manipulation of the DOM and the WebGL context happens on the main UI thread.

The "frontend" UI thread handles user actions and rendering, while the "backend" WebWorker thread handle all queuing, downloading, and preprocessing of data needed for rendering.

# Documentation Index

- [Image Layer Rendering](src/neuroglancer/sliceview/image_layer_rendering.md)
- [Cross-sectional view implementation architecture](src/neuroglancer/sliceview/README.md)
- [Compressed segmentation format](src/neuroglancer/sliceview/compressed_segmentation/README.md)
- [Data chunk management](src/neuroglancer/chunk_manager/)
- [On-GPU hashing](src/neuroglancer/gpu_hash/)

# Building

node.js is required to build the viewer.

1. First install NVM (node version manager) per the instructions here:

  https://github.com/creationix/nvm

2. Install a recent version of Node.js if you haven't already done so:

    `nvm install stable`
    
3. Install the dependencies required by this project:

   (From within this directory)

   `npm i`

   Also re-run this any time the dependencies listed in [package.json](package.json) may have
   changed, such as after checking out a different revision or pulling changes.

4. To run a local server for development purposes:

   `npm run dev-server`
  
   This will start a server on <http://localhost:8080>.
   
5. To run the unit test suite on Chrome:
   
   `npm test`
   
   To run only tests in files matching a given glob pattern:
   
   `npm test -- --pattern='<pattern>'`
   
   For example,
   
   `npm test -- --pattern='src/neuroglancer/util/uint64*'`

6. See [package.json](package.json) for other commands available.

# Creating a dependent project

See [examples/dependent-project](examples/dependent-project).

# Discussion Group

There is a Google Group/mailing list for discussion related to Neuroglancer:
<https://groups.google.com/forum/#!forum/neuroglancer>.

# Related Projects
- [TensorStore](https://github.com/google/tensorstore) - C++ and Python library for efficiently
  reading and writing multi-dimensional arrays in formats supported by Neuroglancer.
- [4Quant/neuroglancer-docker](https://github.com/4Quant/neuroglancer-docker) - Example setup for
  Docker deployment of the [Neuroglancer Python integration](python/README.md).
- [FZJ-INM1-BDA/neuroglancer-scripts](https://github.com/FZJ-INM1-BDA/neuroglancer-scripts) -
  Scripts for converting the [BigBrain](https://bigbrain.loris.ca) dataset to the
  Neuroglancer [precomputed data format](src/neuroglancer/datasource/precomputed), which may serve
  as a useful example for converting other datasets.
- [BigArrays.jl](https://github.com/seung-lab/BigArrays.jl) - Julia interface of neuroglancer precomputed data format.
- [cloudvolume](https://github.com/seung-lab/cloud-volume) - Python interface of neuroglancer precomputed data format.
- [multiresolution-mesh-creator](https://github.com/janelia-cosem/multiresolution-mesh-creator) - Python tool for creating [multi-resolution meshes](https://github.com/google/neuroglancer/blob/master/src/neuroglancer/datasource/precomputed/meshes.md#multi-resolution-mesh-format) from single resolution - or multiscale - meshes.
- [Igneous](https://github.com/seung-lab/igneous) - Python pipeline for scalable meshing, skeletonizing, downsampling, and managment of large 3d images focusing on Neuroglancer Precomputed format.

# Contributing

Want to contribute?  Great!  First, read [CONTRIBUTING.md](CONTRIBUTING.md).

# Acknowledgements
[<img src="https://neuroglancer-public-data.storage.googleapis.com/website/powered-by-sauce-labs-gray.svg" alt="Powered by Sauce Labs" width=300 align="center">](https://saucelabs.com)
Cross-browser Testing Platform and Open Source <3 Provided by [Sauce Labs](https://saucelabs.com)

# License

Copyright 2016 Google Inc.
 
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this software except in compliance with the License.
You may obtain a copy of the License at <http://www.apache.org/licenses/LICENSE-2.0>.

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
