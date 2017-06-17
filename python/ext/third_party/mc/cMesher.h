/*
Passing variables / arrays between cython and cpp
Example from 
http://docs.cython.org/src/userguide/wrapping_CPlusPlus.html

Adapted to include passing of multidimensional arrays

*/

#include <vector>
#include <iostream>
#include <zi/mesh/marching_cubes.hpp>

struct meshobj {
  std::vector<float> points;
  std::vector<float> normals;
  std::vector<unsigned int> faces;
};

class cMesher {
public:
  cMesher();
  ~cMesher();
  void mesh(const std::vector<unsigned int> &data,
            unsigned int sx, unsigned int sy, unsigned int sz);
  std::vector<unsigned int> ids();
  meshobj get_mesh(const unsigned int id, const bool generate_normals, const int simplification_factor, const int max_error);
  bool write_obj(const unsigned int id, const std::string &filename);
private:
  zi::mesh::marching_cubes<unsigned int> mc;
  zi::mesh::simplifier<double> s;
};
