import argparse
import asyncio
import atexit
import concurrent
import shutil
import tempfile
import threading

import neuroglancer
import neuroglancer.cli
import neuroglancer.random_token
import neuroglancer.write_annotations
import numpy as np
import tornado.httpserver
import tornado.netutil
import tornado.platform
import tornado.web


class CorsStaticFileHandler(tornado.web.StaticFileHandler):

    def set_default_headers(self):
        self.set_header("Access-Control-Allow-Origin", "*")
        self.set_header("Access-Control-Allow-Headers", "x-requested-with")
        self.set_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')

    def options(self, *args):
        self.set_status(204)
        self.finish()


def _start_server(bind_address: str, output_dir: str) -> int:

    token = neuroglancer.random_token.make_random_token()
    handlers = [
        (fr'/{token}/(.*)', CorsStaticFileHandler, {
            'path': output_dir
        }),
    ]
    settings = {}
    app = tornado.web.Application(handlers, settings=settings)

    http_server = tornado.httpserver.HTTPServer(app)
    sockets = tornado.netutil.bind_sockets(port=0, address=bind_address)
    http_server.add_sockets(sockets)
    actual_port = sockets[0].getsockname()[1]
    url = neuroglancer.server._get_server_url(bind_address, actual_port)
    return f'{url}/{token}'


def launch_server(bind_address: str, output_dir: str) -> int:
    server_url_future = concurrent.futures.Future()

    def run_server():
        try:
            ioloop = tornado.platform.asyncio.AsyncIOLoop()
            ioloop.make_current()
            asyncio.set_event_loop(ioloop.asyncio_loop)
            server_url_future.set_result(_start_server(bind_address, output_dir))
        except Exception as e:
            server_url_future.set_exception(e)
            return
        ioloop.start()
        ioloop.close()

    thread = threading.Thread(target=run_server)
    thread.daemon = True
    thread.start()
    return server_url_future.result()


def write_some_annotations(output_dir: str, coordinate_space: neuroglancer.CoordinateSpace):

    writer = neuroglancer.write_annotations.AnnotationWriter(
        coordinate_space=coordinate_space,
        annotation_type='point',
        properties=[
            neuroglancer.AnnotationPropertySpec(id='size', type='float32'),
            neuroglancer.AnnotationPropertySpec(id='cell_type', type='uint16'),
            neuroglancer.AnnotationPropertySpec(id='point_color', type='rgba'),
        ],
    )

    writer.add_point([20, 30, 40], size=10, cell_type=16, point_color=(0, 255, 0, 255))
    writer.add_point([50, 51, 52], size=30, cell_type=16, point_color=(255, 0, 0, 255))
    writer.write(output_dir)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)
    viewer = neuroglancer.Viewer()

    tempdir = tempfile.mkdtemp()
    atexit.register(shutil.rmtree, tempdir)

    coordinate_space = neuroglancer.CoordinateSpace(names=['x', 'y', 'z'],
                                                    units=['nm', 'nm', 'nm'],
                                                    scales=[10, 10, 10])
    write_some_annotations(output_dir=tempdir, coordinate_space=coordinate_space)

    server_url = launch_server(bind_address=args.bind_address or '127.0.0.1', output_dir=tempdir)

    with viewer.txn() as s:
        s.layers['image'] = neuroglancer.ImageLayer(source=neuroglancer.LocalVolume(
            data=np.full(fill_value=200, shape=(100, 100, 100), dtype=np.uint8),
            dimensions=coordinate_space),
                                                    )
        s.layers['annotations'] = neuroglancer.AnnotationLayer(source=f'precomputed://{server_url}',
                                                               tab='rendering',
                                                               shader="""
void main() {
  setColor(prop_point_color());
  setPointMarkerSize(prop_size());
}
        """)
        s.selected_layer.layer = 'annotations'
        s.selected_layer.visible = True
        s.show_slices = False
    print(viewer)
