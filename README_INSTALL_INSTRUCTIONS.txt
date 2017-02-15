Code written during a software project by Kaju Bubanja with supervision by Thomas Templier, Hahnloser laboratory, Institute of Neuroinformatics, University of Zurich and ETH Zurich.

Worked on Windows 8, Windows 10, with Oculus DK2, with Chromium VR build and Firefox nightly build.

How to install:
1. Follow instructions here: https://github.com/google/neuroglancer
2. Download chromium and follow instructions here: https://webvr.info/get-chrome/
3. (Not needed if VR device is available) Download this chrome extension: https://chrome.google.com/webstore/detail/webvr-api-emulation/gbdnpaebafagioggnhkacnaaahpiefil
4. Copy raw content from https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/webvr-api/index.d.ts to bottom of node_modules/typescript/lib/lib.es6.d.ts
5. run "npm i" in neuroglancer dir
6. run "npm run dev-server" in neuroglancer dir
7. Enter url: 
http://localhost:8080//#!{'layers':{'original-image':{'type':'image'_'source':'precomputed://gs://neuroglancer-public-data/kasthuri2011/image'_'visible':false}_'corrected-image':{'type':'image'_'source':'precomputed://gs://neuroglancer-public-data/kasthuri2011/image_color_corrected'}_'ground_truth':{'type':'segmentation'_'source':'precomputed://gs://neuroglancer-public-data/kasthuri2011/ground_truth'_'selectedAlpha':0.63_'notSelectedAlpha':0.14_'segments':['2282'_'4965'_'3189'_'4027'_'13'_'3224'_'3208'_'4901'_'15'_'3710'_'4651'_'3758'_'3228'_'444'_'3207']}}_'navigation':{'pose':{'position':{'voxelSize':[6_6_30]_'voxelCoordinates':[5523.99072265625_8538.9384765625_1198.0423583984375]}}_'zoomFactor':22.573112129999547}_'perspectiveOrientation':[0.08078208565711975_-0.9722681045532227_-0.2154746651649475_0.04170951992273331]_'perspectiveZoom':561.1565938529941_'layout':'stereo'}
10. (Optional) If typescript does not find the WebVR function definitions, add "typescript.tsdk": "node_modules/typescript/lib" to the Visual Studio Code settings.