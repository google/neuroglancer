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

#ifndef ZI_MESH_FACE_MESH_HPP
#define ZI_MESH_FACE_MESH_HPP 1

#include <zi/mesh/marching_cubes.hpp>
#include <boost/shared_ptr.hpp>

namespace zi {
namespace mesh {

namespace detail {

template< class T >
struct floating_point_compare_predicate
{
    bool operator()( const T& lhs, const T& rhs ) const
    {
        const int64_t l = static_cast<int64_t>(static_cast<long double>(lhs)*10000000);
        const int64_t r = static_cast<int64_t>(static_cast<long double>(rhs)*10000000);
        return l < r;
    }
};

template< typename T >
struct less;

template< typename T, std::size_t N >
struct less< zi::vl::vec< T, N > >
{
    bool operator()( const zi::vl::vec< T, N >& lhs, const zi::vl::vec< T, N >& rhs ) const
    {
        floating_point_compare_predicate<T> pred;
        return std::lexicographical_compare( lhs.begin(), lhs.end(),
                                             rhs.begin(), rhs.end(), pred );

    }
};


}

template< typename T >
class face_mesh
{
public:
    typedef vl::vec<T, 3>        point_t;
    typedef vl::vec<uint32_t, 3> face_t ;

private:
    //typedef std::map< point_t, uint32_t, vl::less<point_t> > map_t;
    typedef std::map< point_t, uint32_t, detail::less<point_t> > map_t;

    std::vector< face_t  > faces_  ;
    std::vector< point_t > points_ ;
    std::vector< point_t > normals_;
    map_t                  map_    ;

public:
    std::vector< point_t >& points()
    {
        return points_;
    }

    const std::vector< point_t >& points() const
    {
        return points_;
    }

    std::vector< point_t >& normals()
    {
        return normals_;
    }

    const std::vector< point_t >& normals() const
    {
        return normals_;
    }

    std::vector< face_t >& faces()
    {
        return faces_;
    }

    const std::vector< face_t >& faces() const
    {
        return faces_;
    }

    void clear()
    {
        points_.clear();
        normals_.clear();
        faces_.clear();
        map_.clear();
    }

    void add(const std::vector< point_t >& p,
             const std::vector< point_t >& n,
             const std::vector< face_t >& f,
             const T& x=T(0), const T& y=T(0), const T& z=T(0))
    {
        std::size_t matches = 0;

        point_t off(x, y, z);
        for ( std::size_t i = 0; i < p.size(); ++i )
        {
            typename map_t::const_iterator it = map_.find(p[i]+off);
            if ( it == map_.end() )
            {
                map_.insert(std::make_pair(p[i]+off, static_cast<uint32_t>(points_.size())));
                points_.push_back(p[i]+off);
                normals_.push_back(n[i]);
            }
            else
            {
                normals_[ it->second ] = (normals_[ it->second ] + n[i]);
                ++matches;
            }
        }
        for ( std::size_t i = 0; i < f.size(); ++i )
        {
            uint32_t f0 = map_[p[f[i][0]]+off];
            uint32_t f1 = map_[p[f[i][1]]+off];
            uint32_t f2 = map_[p[f[i][2]]+off];

            // if ( f0 == f1 || f1 == f2 || f2 == f0 )
            // {
            //     std::cout << "F1: " << p[f[i][0]]+off << "\n";
            //     std::cout << "F2: " << p[f[i][1]]+off << "\n";
            //     std::cout << "F3: " << p[f[i][2]]+off << "\n";
            //     std::cout << "f1: " << f[i][0] << "\n";
            //     std::cout << "f2: " << f[i][1] << "\n";
            //     std::cout << "f3: " << f[i][2] << "\n";
            //     std::cout << "-f1: " << f0 << "\n";
            //     std::cout << "-f2: " << f1 << "\n";
            //     std::cout << "-f3: " << f2 << "\n";
            // }

            faces_.push_back(face_t(f0,f1,f2));
        }

        //std::cout << "Matching overlap: " << matches << " out of " << p.size() << '\n';

    }

    void add( const point_t* p, const point_t* n, std::size_t psize,
              const face_t* f, std::size_t fsize,
              const T& x=T(0), const T& y=T(0), const T& z=T(0))
    {
        std::size_t matches = 0;

        point_t off(x, y, z);
        for ( std::size_t i = 0; i < psize; ++i )
        {
            typename map_t::const_iterator it = map_.find(p[i]+off);
            if ( it == map_.end() )
            {
                map_.insert(std::make_pair(p[i]+off, static_cast<uint32_t>(points_.size())));
                points_.push_back(p[i]+off);
                normals_.push_back(n[i]);
            }
            else
            {
                normals_[ it->second ] = (normals_[ it->second ] + n[i]);
                ++matches;
            }
        }
        for ( std::size_t i = 0; i < fsize; ++i )
        {
            faces_.push_back(face_t(map_[p[f[i][0]]+off],
                                    map_[p[f[i][1]]+off],
                                    map_[p[f[i][2]]+off]));
        }

        //std::cout << "Matching overlap: " << matches << " out of " << psize << '\n';
    }

    void add( const face_mesh& fm,
              const T& x=T(0), const T& y=T(0), const T& z=T(0))
    {
        add(fm.points(), fm.normals(), fm.faces(), x, y, z);
    }

    void add( boost::shared_ptr<face_mesh> v,
              const T& x=T(0), const T& y=T(0), const T& z=T(0))
    {
        if ( v )
        {
            add(*v.get(), x, y, z);
        }
    }

    std::size_t size() const
    {
        return faces_.size();
    }

    std::size_t mem_size() const
    {
        return points_.capacity() * sizeof(point_t)
            + normals_.capacity() * sizeof(point_t)
            + faces_.capacity() * sizeof(face_t)
            + map_.size() * ( sizeof( typename map_t::value_type ) + 2 * sizeof(std::ptrdiff_t));
    }

    template< class W > std::size_t
    fill_simplifier( ::zi::mesh::simplifier< W >& ret,
                     const point_t& trans = point_t(0,0,0),
                     const point_t& scale = point_t(1,1,1) )
    {
        ret.resize( points_.size() );

        for ( std::size_t i = 0; i < points_.size(); ++i )
        {
            ret.point( i ) = vl::inner_product( points_[i], scale ) + trans;
            ret.normal( i ) = normals_[i];
        }

        FOR_EACH( it, faces_ )
        {
            ret.add_face( it->at(0), it->at(1), it->at(2) );
        }

        return points_.size();

    }

};

} // namespace mesh
} // namespace zi

#endif
