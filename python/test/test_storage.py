import pytest
import re
import shutil
import time

from neuroglancer.pipeline import Storage

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
    urls = ["file:///tmp/removeme/read_write",
            "gs://neuroglancer/removeme/read_write",
            "s3://neuroglancer/removeme/read_write"]

    for num_threads in xrange(0,11,5):
        for url in urls:
            with Storage(url, n_threads=num_threads) as s:
                content = 'some_string'
                s.put_file('info', content, compress=False)
                s.wait()
                assert s.get_file('info') == content
                assert s.get_file('nonexistentfile') is None

                num_infos = max(num_threads, 1)

                results = s.get_files([ 'info' for i in xrange(num_infos) ])

                assert len(results) == num_infos
                assert results[0]['filename'] == 'info'
                assert results[0]['content'] == content
                assert all(map(lambda x: x['error'] is None, results))
                assert s.get_files([ 'nonexistentfile' ])[0]['content'] is None

    shutil.rmtree("/tmp/removeme/read_write")

def test_compression():
    urls = ["file:///tmp/removeme/compression",
            "gs://neuroglancer/removeme/compression",
            "s3://neuroglancer/removeme/compression"]

    for url in urls:
        with Storage(url, n_threads=5) as s:
            content = 'some_string'
            s.put_file('info', content, compress=True)
            s.wait()
            assert s.get_file('info') == content
            assert s.get_file('nonexistentfile') is None

    shutil.rmtree("/tmp/removeme/compression")

def test_list():  
    urls = ["file:///tmp/removeme/list",
            "gs://neuroglancer/removeme/list",
            "s3://neuroglancer/removeme/list"]

    for url in urls:
        with Storage(url, n_threads=5) as s:
            content = 'some_string'
            s.put_file('info1', content, compress=False)
            s.put_file('info2', content, compress=False)
            s.put_file('build/info3', content, compress=False)
            s.wait()
            time.sleep(1) # sometimes it takes a moment for google to update the list
            assert set(s.list_files(prefix='')) == set(['info1','info2'])
            assert set(s.list_files(prefix='inf')) == set(['info1','info2'])
            assert set(s.list_files(prefix='info1')) == set(['info1'])
            assert set(s.list_files(prefix='build')) == set([])
            assert set(s.list_files(prefix='build/')) == set(['info3'])
            assert set(s.list_files(prefix='nofolder/')) == set([])
    
    shutil.rmtree("/tmp/removeme/list")
