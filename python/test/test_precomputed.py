import pytest

import shutil
import numpy as np
from neuroglancer.ingest.volumes.precomputed import Precomputed
from neuroglancer.ingest.storage import Storage
from neuroglancer.ingest.submit_task import (upload_build_chunks, create_info_file_from_build,
    create_ingest_task, MockTaskQueue)

def create_layer(size, offset, layer_type="image"):
    storage = Storage('file:///tmp/removeme/layer', n_threads=0)

    if layer_type == "image":
        random_data = np.random.randint(255, size=size, dtype=np.uint8)
        upload_build_chunks(storage, random_data, offset)
        # Jpeg encoding is lossy so it won't work
        create_info_file_from_build(storage, layer_type= 'image', encoding="raw")
    else:
        random_data = np.random.randint(0xFFFFFF, size=size, dtype=np.uint32)
        upload_build_chunks(storage, random_data, offset)
        # Jpeg encoding is lossy so it won't work
        create_info_file_from_build(storage, layer_type= 'segmentation', encoding="raw")
    create_ingest_task(storage, MockTaskQueue())
    return storage, random_data

def delete_layer():
    shutil.rmtree("/tmp/removeme/layer", ignore_errors=True)
    
def test_read():
    delete_layer()
    storage, data = create_layer(size=(50,50,50,1), offset=(0,0,0))
    pr = Precomputed(storage)
    #the last dimension is the number of channels
    assert pr[0:50,0:50,0:50].shape == (50,50,50,1)
    assert np.all(pr[0:50,0:50,0:50] ==  data)
    
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(0,0,0))
    pr = Precomputed(storage)
    #the last dimension is the number of channels
    assert pr[0:64,0:64,0:64].shape == (64,64,64,1) 
    assert np.all(pr[0:64,0:64,0:64] ==  data[:64,:64,:64,:])

    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(0,0,0))
    pr = Precomputed(storage)
    #the last dimension is the number of channels
    assert pr[31:65,0:64,0:64].shape == (64,64,64,1) 
    assert np.all(pr[31:65,0:64,0:64] ==  data[31:65,:64,:64,:])
    
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(10,20,0))
    pr = Precomputed(storage)
    cutout = pr[10:74,20:84,0:64]
    #the last dimension is the number of channels
    assert cutout.shape == (64,64,64,1) 
    assert np.all(cutout ==  data[:64,:64,:64,:])
    #get the second chunk
    cutout2 = pr[74:138,20:84,0:64]
    assert cutout2.shape == (64,64,64,1) 
    assert np.all(cutout2 ==  data[64:128,:64,:64,:])

def test_write():
    delete_layer()
    storage, data = create_layer(size=(50,50,50,1), offset=(0,0,0))
    pr = Precomputed(storage)

    replacement_data = np.zeros(shape=(50,50,50,1), dtype=np.uint8)
    pr[0:50,0:50,0:50] = replacement_data
    assert np.all(pr[0:50,0:50,0:50] == replacement_data)

    replacement_data  = np.random.randint(255, size=(50,50,50,1), dtype=np.uint8)
    pr[0:50,0:50,0:50] = replacement_data
    assert np.all(pr[0:50,0:50,0:50] == replacement_data)

    #test second chunk
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(10,20,0))
    pr = Precomputed(storage)
    pr[74:138,20:84,0:64] = np.ones(shape=(64,64,64,1), dtype=np.uint8)
    assert np.all(pr[74:138,20:84,0:64] ==  np.ones(shape=(64,64,64,1), dtype=np.uint8))
    
def test_reader_valid_size():
    """
    Stop has to be larger than start,
    stop has to be smaller than layer size
    """
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(0,0,0))
    pr = Precomputed(storage)
    with pytest.raises(ValueError):
        pr._slice_to_chunks([slice(0,0)], slc_idx=0)
    
    with pytest.raises(ValueError):
        pr._slice_to_chunks([slice(64,64)], slc_idx=0)

    with pytest.raises(ValueError):
        pr._slice_to_chunks([slice(128,64)], slc_idx=0)

    with pytest.raises(ValueError):
        pr._slice_to_chunks([slice(0,64*20)], slc_idx=0)

def test_reader_last_chunk_smaller():
    """
    we make it believe the last chunk is smaller by hacking the info file
    """
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(0,0,0))
    pr = Precomputed(storage)
    pr.info['scales'][0]['size'] = (100,64,64)

    assert [(0,64),(64,100)] == pr._slice_to_chunks([slice(0,100)], slc_idx=0)
    with pytest.raises(ValueError):
        pr._slice_to_chunks([slice(0,1024)], slc_idx=0)


def test_reader_negative_indexing():
    """negative indexing is not supported"""
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(0,0,0))
    pr = Precomputed(storage)
    with pytest.raises(ValueError):
        pr._slice_to_chunks([slice(0,-1)], slc_idx=0)

    with pytest.raises(ValueError):
        pr._slice_to_chunks([slice(-1,0)], slc_idx=0)

    with pytest.raises(ValueError):
        pr._slice_to_chunks([slice(-1,-1)], slc_idx=0)

def test_reader_grid_aligned():
    """indexing has to be grid aligned"""
    delete_layer()
    storage, data = create_layer(size=(128,64,64,1), offset=(0,0,0))
    pr = Precomputed(storage)
    assert [(0,64)] == pr._slice_to_chunks([slice(0,64)], slc_idx=0)
    assert [(64,128)] == pr._slice_to_chunks([slice(64,128)], slc_idx=0)
    
    with pytest.raises(ValueError):
        pr._slice_to_chunks([slice(0,63)], slc_idx=0)

    with pytest.raises(ValueError):
        pr._slice_to_chunks([slice(0,63)], slc_idx=0)

    with pytest.raises(ValueError):
        pr._slice_to_chunks([slice(1,64)], slc_idx=0)

    with pytest.raises(ValueError):
        pr._slice_to_chunks([slice(63,128)], slc_idx=0)
