//
// Copyright (C) 2010  Aleksandar Zlateski <zlateski@mit.edu>
// ----------------------------------------------------------
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//

#ifndef ZI_MESH_TRI_MESH_VERTEX_HPP
#define ZI_MESH_TRI_MESH_VERTEX_HPP 1

#include <zi/bits/cstdint.hpp>
#include <zi/bits/unordered_set.hpp>
#include <zi/bits/unordered_map.hpp>

#include <iterator>
#include <cstddef>

namespace zi {
namespace mesh {
namespace detail {

// forward declaration
class tri_mesh;

struct tri_mesh_vertex_impl
{
private:
    uint32_t face_;
    uint32_t open_;

    static const uint32_t valid_edge   = 0x80000000;
    static const uint32_t invalid_edge = 0x7fffffff;

public:
    inline tri_mesh_vertex(): face_( 0 ), open_( 0 )
    {
    }

    inline bool valid() const
    {
        return open_ & valid_edge;
    }

    inline bool on_border() const
    {
        return open_ != valid_edge;
    }

    inline uint32_t face() const
    {
        return face_;
    }

    friend class tri_mesh;

private:
    inline void validate()
    {
        open_ |= valid_edge;
    }

    inline void unvalidate()
    {
        open_ &= invalid_edge;
    }

    inline void face( uint32_t f )
    {
        face_ = f;
        validate();
    }

};



} // namespace detail
} // namespace mesh
} // namespace zi

#endif
