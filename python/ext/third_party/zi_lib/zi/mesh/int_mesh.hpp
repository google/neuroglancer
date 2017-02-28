//
// Copyright (C) 2012  Aleksandar Zlateski <zlateski@mit.edu>
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

#ifndef ZI_MESH_INT_MESH_HPP
#define ZI_MESH_INT_MESH_HPP 1

#include <zi/mesh/marching_cubes.hpp>
#include <boost/shared_ptr.hpp>

namespace zi {
namespace mesh {

class int_mesh
{
private:
    typedef marching_cubes<int>  marcher_t ;

public:
    typedef vl::vec<uint64_t, 3> triangle_t;

private:
    std::vector< triangle_t > v_;

public:
    std::vector< triangle_t >& data()
    {
        return v_;
    }

    const std::vector< triangle_t >& data() const
    {
        return v_;
    }

    void clear()
    {
        v_.clear();
    }

    void add(const std::vector< triangle_t >& v, uint64_t x=0, uint64_t y=0, uint64_t z=0)
    {
        uint64_t off = marcher_t::pack_coords(x*2,y*2,z*2);
        for ( std::size_t i = 0; i < v.size(); ++i )
        {
            v_.push_back(v[i]+off);
        }
    }

    void add( const triangle_t * v, std::size_t size, uint64_t x=0, uint64_t y=0, uint64_t z=0)
    {
        uint64_t off = marcher_t::pack_coords(x*2,y*2,z*2);
        for ( std::size_t i = 0; i < size; ++i )
        {
            v_.push_back(v[i]+off);
        }
    }

    void add( const int_mesh& v, uint64_t x=0, uint64_t y=0, uint64_t z=0)
    {
        add(v.data(), x, y, z);
    }

    void add( boost::shared_ptr<int_mesh> v, uint64_t x=0, uint64_t y=0, uint64_t z=0)
    {
        if ( v )
        {
            add(*v.get(), x, y, z);
        }
    }

    std::size_t size() const
    {
        return v_.size();
    }

    std::size_t mem_size() const
    {
        return v_.capacity() * sizeof(triangle_t);
    }

    void print() const
    {
        for ( std::size_t i = 0; i < v_.size(); ++i )
        {
            std::cout << (v_[i][1] & 0x1FFFFF) << "\n";
        }
    }

    template< class T > std::size_t
    fill_simplifier( ::zi::mesh::simplifier< T >& ret,
                     const T& xtrans = T( 0 ),
                     const T& ytrans = T( 0 ),
                     const T& ztrans = T( 0 ),
                     const T& xscale = T( 1 ),
                     const T& yscale = T( 1 ),
                     const T& zscale = T( 1 ) ) const
    {
        uint32_t idx = 0;
        unordered_map< uint64_t, uint32_t > pts;

        const std::vector< triangle_t >& data = v_;

        FOR_EACH( it, data )
        {
            if ( !pts.count( it->at(0) ) )
            {
                pts.insert( std::make_pair( it->at(0), idx++ ) );
            }
            if ( !pts.count( it->at(1) ) )
            {
                pts.insert( std::make_pair( it->at(1), idx++ ) );
            }
            if ( !pts.count( it->at(2) ) )
            {
                pts.insert( std::make_pair( it->at(2), idx++ ) );
            }
        }

        ret.resize( idx );

        FOR_EACH( it, pts )
        {
            ret.point( it->second ) = vl::vec< T, 3 >
                ( marching_cubes<int>::template unpack_x< T >( it->first, xtrans, xscale ),
                  marching_cubes<int>::template unpack_y< T >( it->first, ytrans, yscale ),
                  marching_cubes<int>::template unpack_z< T >( it->first, ztrans, zscale ) );
        }

        FOR_EACH( it, data )
        {
            ret.add_face( pts[ it->at(0) ], pts[ it->at(1) ], pts[ it->at(2) ] );
        }

        return idx;

    }
};

} // namespace mesh
} // namespace zi

#endif
