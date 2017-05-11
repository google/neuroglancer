import pytest

import shutil
import numpy as np

import os

from neuroglancer.pipeline.storage import Storage
from neuroglancer.pipeline.task_creation import (upload_build_chunks, create_info_file_from_build,
    create_ingest_task, MockTaskQueue)

layer_path = '/tmp/removeme/'

def create_storage(layer_name='layer'):
    uri = 'file://' + os.path.join(layer_path, layer_name)
    return Storage(uri, n_threads=0)

def create_layer(size, offset=[0,0,0], layer_type="image", layer_name="layer"):
    storage = create_storage(layer_name)

    if layer_type == "image":
        random_data = np.random.randint(255, size=size, dtype=np.uint8)
        upload_build_chunks(storage, random_data, offset)
        # Jpeg encoding is lossy so it won't work
        create_info_file_from_build(storage, layer_type= 'image', encoding="raw", force_chunk=[64,64,64])
    elif layer_type == "affinities":
        random_data = np.random.uniform(size=size).astype(np.float32)
        upload_build_chunks(storage, random_data, offset)
        create_info_file_from_build(storage, layer_type= 'image', encoding="raw", force_chunk=[64,64,64])
    elif layer_type == "segmentation":
        random_data = np.random.randint(0xFFFFFF, size=size, dtype=np.uint32)
        upload_build_chunks(storage, random_data, offset)
        # Jpeg encoding is lossy so it won't work
        create_info_file_from_build(storage, layer_type= 'segmentation', encoding="raw", force_chunk=[64,64,64])
    create_ingest_task(storage, MockTaskQueue())
    return storage, random_data
    
def delete_layer(layer_name="layer"):
    path = os.path.join(layer_path, layer_name)
    if os.path.exists(path):
        shutil.rmtree(path)

    
    
    