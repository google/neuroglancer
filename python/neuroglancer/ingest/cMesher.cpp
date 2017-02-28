/*
Passing variables / arrays between cython and cpp
Example from 
http://docs.cython.org/src/userguide/wrapping_CPlusPlus.html

Adapted to include passing of multidimensional arrays

*/

#include <zi/mesh/int_mesh.hpp>
#include <zi/mesh/quadratic_simplifier.hpp>
#include <zi/vl/vec.hpp>
#include <vector>
#include <fstream>


#include "cMesher.h"

//////////////////////////////////
cMesher::cMesher()
{
}

cMesher::~cMesher()
{
}


bool WriteObj(zi::mesh::simplifier<double> & s, const std::string & filename) {
  std::vector<zi::vl::vec3d> points;
  std::vector<zi::vl::vec3d> normals;
  std::vector<zi::vl::vec<unsigned,3> > faces;

  s.get_faces(points, normals, faces);

  std::ofstream out(filename.c_str(), std::ios::out);
  if (out) {
    for (auto v = points.begin(); v < points.end(); ++v) {
      out << "v " << (*v)[2] << " " << (*v)[1] << " " << (*v)[0] << "\n";
    }

    for (auto vn = normals.begin(); vn < normals.end(); ++vn) {
      out << "vn " << (*vn)[2] << " " << (*vn)[1] << " " << (*vn)[0] << "\n";
    }

    for (auto f = faces.begin(); f < faces.end(); ++f) {
      out << "f " << (*f)[0] + 1 << "//" << (*f)[0] + 1 << " " << (*f)[2] + 1
        << "//" << (*f)[2] + 1 << " " << (*f)[1] + 1 << "//" << (*f)[1] + 1
        << "\n";
    }
    return true;
  }
  return false;
}

void cMesher::mesh(const std::vector<unsigned int> &data,
                    unsigned int sx, unsigned int sy, unsigned int sz)
{

  // Create Marching Cubes class for type T volume

  const unsigned int* a = &data[0];
  // Run global marching cubes, a mesh is generated for each segment ID group
  this->mc.marche(a, sx, sy, sz);

  // if (mc.count(9) > 0) { // If segment ID 1 has more than zero triangles
    // WriteObj(s, "out.obj");

    // s.optimize(s.face_count() / 10, 1e-12); // target triangle count, allowed geometric error (1e-12 -- no tolerance)
    // WriteObj(s, "out.obj");
  // }
}

std::vector<unsigned int> cMesher::ids() {

  std::vector<unsigned int> keys;
  for ( auto it= this->mc.meshes().begin(); it != this->mc.meshes().end(); ++it )
    keys.push_back(it->first);

  return keys;
}

bool cMesher::write_obj(const unsigned int id, const std::string &filename) {
  zi::mesh::int_mesh im;
  im.add(mc.get_triangles(id));
  im.fill_simplifier<double>(s);
  s.prepare(true);

  WriteObj(s, filename);

  return true;
}

meshobj cMesher::get_mesh(const unsigned int id, const bool generate_normals, const int simplification_factor, const int max_simplification_error) {
    meshobj obj;

    zi::mesh::int_mesh im;
    im.add(mc.get_triangles(id));
    im.fill_simplifier<double>(s);
    s.prepare(generate_normals);

    if (simplification_factor > 0) {
      s.optimize(s.face_count() / simplification_factor, max_simplification_error); // this is the most cpu intensive line
    }

    std::vector<zi::vl::vec3d> points;
    std::vector<zi::vl::vec3d> normals;
    std::vector<zi::vl::vec<unsigned,3> > faces;

    s.get_faces(points, normals, faces);
    obj.points.reserve(3* points.size());
    obj.faces.reserve(3 * faces.size());

    if (generate_normals) {
      obj.normals.reserve(3 * points.size());
    }
    else {
      obj.normals.reserve(1); 
    }

    for (auto v = points.begin(); v != points.end(); ++v) {
        obj.points.push_back((*v)[2]);
        obj.points.push_back((*v)[1]);
        obj.points.push_back((*v)[0]);
    }

    if (generate_normals) {
      for (auto vn = normals.begin(); vn != normals.end(); ++vn) {
          obj.normals.push_back((*vn)[2]);
          obj.normals.push_back((*vn)[1]);
          obj.normals.push_back((*vn)[0]);
      }
    }

    for (auto f = faces.begin(); f != faces.end(); ++f) {
        obj.faces.push_back((*f)[0]);
        obj.faces.push_back((*f)[2]);
        obj.faces.push_back((*f)[1]);
    }

  return obj; 
}