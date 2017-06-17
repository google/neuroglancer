from collections import defaultdict

import json
from jsonschema import validate

from neuroglancer.pipeline import Storage

class Provenance(object):
  def __init__(self, cloudpath, data=None):
    self.cloudpath = cloudpath

    if not data:
      with Storage(cloudpath, n_threads=0) as stor:
        data = stor.get_file('provenance')
        if data:
          self.fromjson(data)
        else:
          self.reset()
    else:
      self.reset(data)

  def commit(self):
    formatted = self.tojson()
    with Storage(self.cloudpath, n_threads=0) as stor:
      stor.put_file('provenance', self.tojson(), compress=False)
    return self

  def fromjson(self, jsondata):
    validate(jsondata, self.schema)
    return self.reset(json.loads(jsondata))

  def __str__(self):
    return '<{}: {}>'.format(self.__class__.__name__, self.tojson())


class DatasetProvenance(Provenance):
  schema = {
    "$schema": "http://json-schema.org/draft-04/schema#",
    "description": "Represents a dataset and its derived data layers.",
    "required": [
      "dataset_name", "dataset_description", 
      "organism", "imaged_date", "imaged_by", 
      "owners"
    ],
    "properties": {
      'dataset_name': { 'type': 'string' },
      'dataset_description': { 'type': 'string' },
      'organism': {
        'type': 'string',
        'description': 'Species, sex, strain identifier',
      },
      'imaged_date': { 'type': 'string' },
      'imaged_by': { 'type': 'string' },
      'references': { # e.g. dois, urls, titles
        "type": "array",
        "items": {
          "type": "string"
        },
        "minItems": 0,
        "uniqueItems": True, # e.g. email addresses  
      }, 
      'owners': {
        "type": "array",
        "items": {
          "type": "string"
        },
        "minItems": 1,
        "uniqueItems": True, # e.g. email addresses  
      }
    }
  }

  def reset(self, data=defaultdict(unicode)):
    self.dataset_name = data['dataset_name']
    self.dataset_description = data['dataset_description']
    self.organism = data['organism']
    self.imaged_date = data['imaged_date'] 
    self.imaged_by = data['imaged_by']
    self.references = data['references'] or []
    self.owners = data['owners'] or []

  def tojson(self):
    jsonformat = json.dumps({
      'dataset_name': self.dataset_name,
      'dataset_description': self.dataset_description,
      'organism': self.organism,
      'imaged_date': self.imaged_date,
      'imaged_by': self.imaged_by,
      'references': self.references,
      'owners': self.owners,
    })

    validate(jsonformat, self.schema)
    return jsonformat


class DataLayerProvenance(Provenance):
  schema = {
    "$schema": "http://json-schema.org/draft-04/schema#",
    "description": "Represents a data layer within a dataset. e.g. image, segmentation, etc",
    "required": [
      'description', 'sources', 
      'processing', 'owners'
    ],
    "properties": {
      'description': { 'type': 'string' },
      'sources': { # e.g. [ 'gs://neuroglancer/pinky40_v11/image' 
        "type": "array",
        "items": {
          "type": "string"
        },
        "minItems": 0,
        "uniqueItems": True,
      }, 
      'processing': {
        "type": "array",
        "minItems": 0,
        "uniqueItems": True,      
      },
      # e.g. processing = [ 
      #    { 'method': 'inceptionnet', 'by': 'example@princeton.edu' }, 
      #    { 'method': 'downsample', 'by': 'example2@princeton.edu', 'description': 'demo of countless downsampling' } 
      #    { 'method': 'meshing', 'by': 'example2@princeton.edu', 'description': '512x512x512 mip 3 simplification factor 30' }
      # ]
      'owners': {
        "type": "array",
        "items": {
          "type": "string"
        },
        "minItems": 0,
        "uniqueItems": True,
      },
    }
  }

  def reset(self, data=defaultdict(unicode)):
    self.description = data['description']
    self.sources = data['sources'] or []
    self.processing = data['processing'] or []
    self.owners = data['owners'] or []
    return self

  def tojson(self):
    jsonformat = json.dumps({
      'description': self.description,
      'sources': self.sources,
      'processing': self.processing,
      'owners': self.owners,
    })

    validate(jsonformat, self.schema)
    return jsonformat


















