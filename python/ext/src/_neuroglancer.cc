#if defined _WIN32 || defined __CYGWIN__
#define DLL_PUBLIC __declspec(dllexport)
#else
#define DLL_PUBLIC __attribute__((visibility("default")))
#endif

#define NPY_NO_DEPRECATED_API NPY_1_7_API_VERSION

#include "Python.h"
#include "numpy/arrayobject.h"
#include "on_demand_object_mesh_generator.h"
#define MODULE_NAME "_neuroglancer"

namespace neuroglancer {
namespace pywrap_on_demand_object_mesh_generator {

struct Obj {
  PyObject_HEAD meshing::OnDemandObjectMeshGenerator impl;
};

static PyObject* tp_new(PyTypeObject* type, PyObject* args, PyObject* kwds) {
  Obj* self;

  self = reinterpret_cast<Obj*>(type->tp_alloc(type, 0));
  if (self) {
    new (&self->impl) meshing::OnDemandObjectMeshGenerator();
  }
  return reinterpret_cast<PyObject*>(self);
}

static int tp_init(Obj* self, PyObject* args, PyObject* kwds) {
  PyObject* array_argument;
  float voxel_size[3];
  float offset[3];
  meshing::SimplifyOptions simplify_options;
  int lock_boundary_vertices = simplify_options.lock_boundary_vertices;
  static const char* kw_list[] = {"data",
                                  "voxel_size",
                                  "offset",
                                  "max_quadrics_error",
                                  "max_normal_angle_deviation",
                                  "lock_boundary_vertices",
                                  nullptr};
  if (!PyArg_ParseTupleAndKeywords(
          args, kwds, "O(fff)(fff)|ddi:__init__", const_cast<char**>(kw_list),
          &array_argument, voxel_size, voxel_size + 1, voxel_size + 2, offset,
          offset + 1, offset + 2, &simplify_options.max_quadrics_error,
          &simplify_options.max_normal_angle_deviation,
          &lock_boundary_vertices)) {
    return -1;
  }
  simplify_options.lock_boundary_vertices =
      static_cast<bool>(lock_boundary_vertices);
  PyArrayObject* array = reinterpret_cast<PyArrayObject*>(PyArray_CheckFromAny(
      array_argument, /*dtype=*/nullptr, /*min_depth=*/3, /*max_depth=*/3,
      /*requirements=*/NPY_ARRAY_ALIGNED | NPY_ARRAY_NOTSWAPPED,
      /*context=*/nullptr));
  if (!array) {
    return -1;
  }
  auto* descr = PyArray_DESCR(array);
  if ((descr->kind != 'i' && descr->kind != 'u') ||
      (descr->elsize != 1 && descr->elsize != 2 && descr->elsize != 4 &&
       descr->elsize != 8)) {
    Py_DECREF(array);
    PyErr_SetString(PyExc_ValueError,
                    "ndarray must have 8-, 16-, 32-, or 64-bit integer type");
    return -1;
  }

  npy_intp* dims = PyArray_DIMS(array);
  int64_t size_int64[] = {dims[2], dims[1], dims[0]};
  npy_intp* strides_in_bytes = PyArray_STRIDES(array);
  int64_t strides_in_elements[] = {strides_in_bytes[2] / descr->elsize,
                                   strides_in_bytes[1] / descr->elsize,
                                   strides_in_bytes[0] / descr->elsize};

  meshing::OnDemandObjectMeshGenerator impl;

  Py_BEGIN_ALLOW_THREADS;

  switch (descr->elsize) {
    case 1:
      impl = meshing::OnDemandObjectMeshGenerator(
          static_cast<const uint8_t*>(PyArray_DATA(array)), size_int64,
          strides_in_elements, voxel_size, offset, simplify_options);
      break;
    case 2:
      impl = meshing::OnDemandObjectMeshGenerator(
          static_cast<const uint16_t*>(PyArray_DATA(array)), size_int64,
          strides_in_elements, voxel_size, offset, simplify_options);
      break;
    case 4:
      impl = meshing::OnDemandObjectMeshGenerator(
          static_cast<const uint32_t*>(PyArray_DATA(array)), size_int64,
          strides_in_elements, voxel_size, offset, simplify_options);
      break;
    case 8:
      impl = meshing::OnDemandObjectMeshGenerator(
          static_cast<const uint64_t*>(PyArray_DATA(array)), size_int64,
          strides_in_elements, voxel_size, offset, simplify_options);
      break;
  }

  Py_END_ALLOW_THREADS;

  self->impl = impl;

  Py_DECREF(array);
  return 0;
}

static void tp_dealloc(Obj* obj) { obj->impl.~OnDemandObjectMeshGenerator(); }

static PyObject* get_mesh(Obj* self, PyObject* args) {
  auto impl = self->impl;
  if (!impl) {
    PyErr_SetString(PyExc_ValueError, "Not initialized.");
    return nullptr;
  }
  uint64_t object_id;
  if (!PyArg_ParseTuple(args, "K:get_mesh", &object_id)) {
    return nullptr;
  }

  const std::string* encoded_mesh = nullptr;

  Py_BEGIN_ALLOW_THREADS;

  encoded_mesh = &self->impl.GetSimplifiedMesh(object_id);

  Py_END_ALLOW_THREADS;

  if (encoded_mesh->empty()) {
    Py_RETURN_NONE;
  }
  return PyBytes_FromStringAndSize(encoded_mesh->data(), encoded_mesh->size());
}

static PyMethodDef methods[] = {
    {"get_mesh", reinterpret_cast<PyCFunction>(&get_mesh), METH_VARARGS,
     "Retrieve the encoded mesh for an object."},
    {NULL} /* Sentinel */
};

static void register_type(PyObject* module) {
  static PyTypeObject t = {
      PyVarObject_HEAD_INIT(NULL, 0)             /*ob_size*/
      MODULE_NAME ".OnDemandObjectMeshGenerator", /*tp_name*/
      sizeof(Obj),                                /*tp_basicsize*/
  };
  t.tp_flags = Py_TPFLAGS_DEFAULT;
  t.tp_init = reinterpret_cast<initproc>(&tp_init);
  t.tp_new = tp_new;
  t.tp_dealloc = reinterpret_cast<void (*)(PyObject*)>(&tp_dealloc);
  t.tp_doc = "OnDemandObjectMeshGenerator";
  t.tp_methods = methods;
  if (PyType_Ready(&t) < 0) return;
  Py_INCREF(&t);
  PyModule_AddObject(module, "OnDemandObjectMeshGenerator",
                     reinterpret_cast<PyObject*>(&t));
}
}  // namespace pywrap_on_demand_object_mesh_generator


// The following Python2/3 compatibility code was derived from py3c.
// Copyright (c) 2015, Red Hat, Inc. and/or its affiliates
// Licensed under the MIT license.
#if PY_MAJOR_VERSION >= 3
#define MODULE_INIT_FUNC(name) \
  extern "C" DLL_PUBLIC PyObject * PyInit_ ## name(void)
#else
#define PyModuleDef_HEAD_INIT 0

typedef struct PyModuleDef {
    int m_base;
    const char* m_name;
    const char* m_doc;
    Py_ssize_t m_size;
    PyMethodDef *m_methods;
} PyModuleDef;

#define PyModule_Create(def) \
    Py_InitModule3((def)->m_name, (def)->m_methods, (def)->m_doc)

#define MODULE_INIT_FUNC(name) \
    static PyObject *PyInit_ ## name(void); \
    extern "C" DLL_PUBLIC void init ## name(void) { PyInit_ ## name(); } \
    static PyObject *PyInit_ ## name(void)

#endif


MODULE_INIT_FUNC(_neuroglancer) {
  static PyMethodDef module_methods[] = {
      {NULL} /* Sentinel */
  };
  static struct PyModuleDef moduledef = {
    PyModuleDef_HEAD_INIT,
    "_neuroglancer", /* m_name */
    "Neuroglancer C extension module.", /* m_doc */
    -1, /* m_size */
    module_methods
  };
  import_array1(nullptr);
  PyObject* m = PyModule_Create(&moduledef);
  pywrap_on_demand_object_mesh_generator::register_type(m);
  return m;
}

}  // namespace neuroglancer
