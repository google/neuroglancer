import neuroglancer
import neuroglancer.webdriver

viewer = neuroglancer.Viewer()
with viewer.txn() as s:
    s.layers['image'] = neuroglancer.ImageLayer(
        source='precomputed://gs://neuroglancer-janelia-flyem-hemibrain/emdata/clahe_yz/jpeg',
    )
    s.layers['segmentation'] = neuroglancer.SegmentationLayer(
        source='precomputed://gs://neuroglancer-janelia-flyem-hemibrain/v1.1/segmentation',
    )

webdriver = neuroglancer.webdriver.Webdriver(viewer, headless=False)


def get_loading_progress():
    return webdriver.driver.execute_script('''
const userLayer = viewer.layerManager.getLayerByName("segmentation").layer;
return userLayer.renderLayers.map(x => x.layerChunkProgressInfo)
 ''')
