import pytest

import os
import json 

from layer_harness import delete_layer
from neuroglancer.pipeline.volumes.provenance import DataLayerProvenance, DatasetProvenance

def test_dataset_provenance():
  fs = '/tmp/removeme/provenance/'
  delete_layer(fs)

  prov = DatasetProvenance('file://' + fs)

  prov.dataset_name = 'ur-mom-2039'
  prov.dataset_description = 'EM serial section of your mom\'s brain'
  prov.organism = 'Male wild-type (C57BL/6) mouse'
  prov.imaged_date = 'March-Feb 2010'
  prov.imaged_by = 'gradstudent@princeton.edu'
  prov.references = [ 'doi:presigiousjournalofyourmom-12142' ]
  prov.owners = [ 'scientist@princeton.edu', 'techstaff@princeton.edu' ]

  prov.commit()

  path = os.path.join(fs, 'provenance')

  with open(path, 'r') as f:
    data = json.loads(f.read())

  assert data == { 
    'dataset_name': 'ur-mom-2039',
    'dataset_description': 'EM serial section of your mom\'s brain',
    'organism': 'Male wild-type (C57BL/6) mouse',
    'imaged_date': 'March-Feb 2010',
    'imaged_by': 'gradstudent@princeton.edu',
    'references': [ 'doi:presigiousjournalofyourmom-12142' ],
    'owners': [ 'scientist@princeton.edu', 'techstaff@princeton.edu' ],
  }

  prov = DatasetProvenance('file://' + fs)

  assert prov.dataset_name == 'ur-mom-2039'
  assert prov.dataset_description == 'EM serial section of your mom\'s brain'
  assert prov.organism == 'Male wild-type (C57BL/6) mouse'
  assert prov.imaged_date == 'March-Feb 2010'
  assert prov.imaged_by == 'gradstudent@princeton.edu'
  assert prov.references == [ 'doi:presigiousjournalofyourmom-12142' ]
  assert prov.owners == [ 'scientist@princeton.edu', 'techstaff@princeton.edu' ]

def test_data_layer_provenance():
  fs = '/tmp/removeme/provenance/layer/'
  delete_layer(fs)

  prov = DataLayerProvenance('file://' + fs)

  prov.description = 'example dataset'
  prov.sources = [ 'gs://neuroglancer/example/image' ]
  prov.processing = [ 
    { 'method': 'convnet', 'by': 'gradstudent@princeton.edu' },
  ]
  prov.owners = [ 'gradstudent@princeton.edu' ]

  prov.commit()

  path = os.path.join(fs, 'provenance')

  with open(path, 'r') as f:
    data = json.loads(f.read())

  assert data == { 
    'description': 'example dataset', 
    'sources': [ 'gs://neuroglancer/example/image' ],
    'processing': [
      { 'method': 'convnet', 'by': 'gradstudent@princeton.edu' },
    ],
    'owners': [ 'gradstudent@princeton.edu' ]
  }

  prov = DataLayerProvenance('file://' + fs)

  assert prov.description == 'example dataset'
  assert prov.sources == [ 'gs://neuroglancer/example/image' ]
  assert prov.processing == [ { 'method': 'convnet', 'by': 'gradstudent@princeton.edu' } ]
  assert prov.owners == [ 'gradstudent@princeton.edu' ]

