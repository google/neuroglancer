from jsonschema import validate
import python_jsonschema_objects as pjs

__all__ = [ 'DatasetProvenance', 'DataLayerProvenance' ]

dataset_provenance_schema = {
  "$schema": "http://json-schema.org/draft-04/schema#",
  "title": "Dataset Provenance",
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

builder = pjs.ObjectBuilder(dataset_provenance_schema)
classes = builder.build_classes()
DatasetProvenance = classes.DatasetProvenance

layer_provenance_schema = {
  "$schema": "http://json-schema.org/draft-04/schema#",
  "title": "Data Layer Provenance",
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
      "items": {
        "type": "object"
      },
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

builder = pjs.ObjectBuilder(layer_provenance_schema)
classes = builder.build_classes()
DataLayerProvenance = classes.DataLayerProvenance







