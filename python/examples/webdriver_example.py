import argparse
import neuroglancer
import neuroglancer.webdriver
import neuroglancer.cli

ap = argparse.ArgumentParser()
neuroglancer.cli.add_server_arguments(ap)
ap.add_argument('--browser', choices=['chrome', 'firefox'], default='chrome')
args = ap.parse_args()
neuroglancer.cli.handle_server_arguments(args)
viewer = neuroglancer.Viewer()
with viewer.txn() as s:
    s.layers['image'] = neuroglancer.ImageLayer(
        source='precomputed://gs://neuroglancer-janelia-flyem-hemibrain/emdata/clahe_yz/jpeg',
    )
    s.layers['segmentation'] = neuroglancer.SegmentationLayer(
        source='precomputed://gs://neuroglancer-janelia-flyem-hemibrain/v1.1/segmentation',
    )

webdriver = neuroglancer.webdriver.Webdriver(viewer, headless=False, browser=args.browser)


def get_loading_progress():
    return webdriver.driver.execute_script('''
const userLayer = viewer.layerManager.getLayerByName("segmentation").layer;
return userLayer.renderLayers.map(x => x.layerChunkProgressInfo)
 ''')
