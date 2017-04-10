import pytest
import re
import os

from neuroglancer.ingest.storage import Storage

def test_path_extraction():
    assert (Storage.extract_path('s3://bucket_name/dataset_name/layer_name') 
        == Storage.ExtractedPath('s3', "bucket_name", None, 'dataset_name', 'layer_name'))

    assert Storage.extract_path('s4://dataset_name/layer_name') is None

    assert Storage.extract_path('dataset_name/layer_name') is None

    assert Storage.extract_path('s3://dataset_name') is None

    assert (Storage.extract_path('s3://neuroglancer/intermediate/path/dataset_name/layer_name') 
        == Storage.ExtractedPath('s3', 'neuroglancer', 'intermediate/path/','dataset_name', 'layer_name'))

    assert (Storage.extract_path('file:///tmp/dataset_name/layer_name') 
        == Storage.ExtractedPath('file', "/tmp",  None, 'dataset_name', 'layer_name'))

    assert (Storage.extract_path('file://neuroglancer/intermediate/path/dataset_name/layer_name') 
        == Storage.ExtractedPath('file', 'neuroglancer','intermediate/path/','dataset_name', 'layer_name'))

    assert (Storage.extract_path('gs://neuroglancer/intermediate/path/dataset_name/layer_name') 
        == Storage.ExtractedPath('gs', 'neuroglancer', 'intermediate/path/','dataset_name', 'layer_name'))

    assert Storage.extract_path('s3://dataset_name/layer_name/') is None

#TODO delete files created by tests
def test_read_write():
    for url in ["file:///tmp/removeme/read_write",
            "gs://neuroglancer/removeme/read_write",
            "s3://neuroglancer/removeme/read_write"]:
        s = Storage(url, n_threads=5)
        content = 'some_string'
        s.put_file('info', content, compress=False)
        s.wait_until_queue_empty()
        assert s.get_file('info') == content
        assert s.get_file('nonexistentfile') is None

def test_compression():
    for url in ["file:///tmp/removeme/compression",
                "gs://neuroglancer/removeme/compression",
                "s3://neuroglancer/removeme/compression"]:

        s = Storage(url, n_threads=5)
        content = 'some_string'
        s.put_file('info', content, compress=True)
        s.wait_until_queue_empty()
        assert s.get_file('info') == content
        assert s.get_file('nonexistentfile') is None

def test_list():
    for url in ["file:///tmp/removeme/list",
                "gs://neuroglancer/removeme/list",
                "s3://neuroglancer/removeme/list"]:

        s = Storage(url, n_threads=5)
        content = 'some_string'
        s.put_file('info1', content , compress=False)
        s.put_file('info2', content , compress=False)
        s.put_file('build/info3', content , compress=False)
        assert set(s.list_files(prefix='')) == set(['info1','info2'])
        assert set(s.list_files(prefix='inf')) == set(['info1','info2'])
        assert set(s.list_files(prefix='info1')) == set(['info1'])
        assert set(s.list_files(prefix='build')) == set([])
        assert set(s.list_files(prefix='build/')) == set(['info3'])
        assert set(s.list_files(prefix='nofolder/')) == set([])

