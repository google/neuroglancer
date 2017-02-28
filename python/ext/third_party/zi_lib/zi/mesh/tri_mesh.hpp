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

#ifndef ZI_MESH_TRI_MESH_HPP
#define ZI_MESH_TRI_MESH_HPP 1

#include <zi/bits/cstdint.hpp>
#include <zi/bits/hash.hpp>
#include <zi/utility/assert.hpp>
#include <zi/utility/for_each.hpp>
#include <zi/utility/enable_if.hpp>
#include <zi/utility/detail/dummy.hpp>
#include <zi/utility/exception.hpp>

#include <zi/bits/unordered_map.hpp>
#include <vector>
#include <functional>
#include <stdexcept>
#include <iostream>

#include <zi/mesh/detail/tri_mesh_face.hpp>
#include <zi/mesh/detail/tri_mesh_edge.hpp>

namespace zi {
namespace mesh {

namespace detail {

inline uint64_t make_edge( uint32_t x, uint32_t y )
{
    return ( static_cast< uint64_t >( ~x ) << 32 ) | ( ~y );
}

inline uint32_t edge_source( uint64_t e )
{
    return ( static_cast< uint32_t >( ~e >> 32 ) );
}

inline uint32_t edge_sink( uint64_t e )
{
    return ( static_cast< uint32_t >( ~e & 0x7fffffff ) );
}

inline uint64_t edge_inverse( uint64_t e )
{
    return ( e >> 32 ) | ( e << 32 );
}

struct tri_mesh_vertex
{
    static const uint32_t valid_edge   = 0x80000000;
    static const uint32_t invalid_edge = 0x7fffffff;

    uint32_t face_;
    uint32_t open_;

    tri_mesh_vertex(): face_( 0 ), open_( 0 )
    {
    }

    void reset()
    {
        face_ = open_ = 0;
    }

    bool valid() const
    {
        return open_ & valid_edge;
    }

    bool on_border() const
    {
        return open_ != valid_edge;
    }

    uint32_t face() const
    {
        return face_;
    }

    void validate()
    {
        open_ |= valid_edge;
    }

    void unvalidate()
    {
        open_ &= invalid_edge;
    }

    void face( uint32_t f )
    {
        face_ = f;
        validate();
    }

};


} //  namespace detail

class tri_mesh //: non_copyable
{
public:
    typedef detail::tri_mesh_face_impl   face_type   ;
    typedef detail::tri_mesh_vertex      vertex_type ;
    typedef detail::tri_mesh_edge_impl   edge_type   ;

    friend struct tri_mesh_vertex;
    friend struct tri_mesh_face;
    friend struct tri_mesh_edge;

private:
    std::size_t                           size_    ;
    std::vector  < vertex_type >          vertices_;
    unordered_map< uint64_t, edge_type >  edges_   ;
    unordered_map< uint32_t, face_type >  faces_   ;
    uint32_t                              max_face_;

public:
    detail::tri_mesh_face_container       faces;
    detail::tri_mesh_edge_container       edges;

private:

    void add_edge( uint32_t x, uint32_t y, uint32_t z, uint32_t f )
    {
        static_cast< void >( z );

        ZI_ASSERT( x != y );
        ZI_ASSERT( x != z );
        ZI_ASSERT( y != z );

        const uint64_t e = detail::make_edge( x, y );

        // if ( edges_.count( e ) )
        // {
        //     return;
        // }

        ZI_ASSERT_0( edges_.count( e ) );

        if ( edges_.count( detail::edge_inverse( e ) ) )
        {
            --vertices_[ x ].open_;
            --vertices_[ y ].open_;
        }
        else
        {
            ++vertices_[ x ].open_;
            ++vertices_[ y ].open_;
        }

        vertices_[ x ].face( f );

        edges_.insert( std::make_pair( e, edge_type( f, z ) ) );
    }

    void remove_edge( uint32_t x, uint32_t y, uint32_t f )
    {
        const uint64_t e = detail::make_edge( x, y );

        ZI_ASSERT( edges_.count( e ) );

        if ( edges_.count( detail::edge_inverse( e ) ) )
        {
            ++vertices_[ x ].open_;
            ++vertices_[ y ].open_;
        }
        else
        {
            --vertices_[ x ].open_;
            --vertices_[ y ].open_;
        }

        if ( vertices_[ x ].face_ == f )
        {
            vertices_[ x ].unvalidate();
        }

        ZI_VERIFY( edges_.erase( e ) );
    }

public:
    detail::tri_mesh_face_container& get_faces()
    {
        return faces;
    }

    const detail::tri_mesh_face_container& get_faces() const
    {
        return faces;
    }

    std::vector< vertex_type >& vertices()
    {
        return vertices_;
    }

    const std::vector< vertex_type >& vertices() const
    {
        return vertices_;
    }

    detail::tri_mesh_edge_container& get_edges()
    {
        return edges;
    }

    const detail::tri_mesh_edge_container& get_edges() const
    {
        return edges;
    }

    tri_mesh()
        : size_( 0 ),
        vertices_( 0 ),
        edges_(),
        faces_(),
        max_face_( 0 ),
        faces( faces_ ),
        edges( edges_ )
    {
    }

    explicit tri_mesh( std::size_t size )
        : size_( size ),
          vertices_( size ),
          edges_(),
          faces_(),
          max_face_( 0 ),
          faces( faces_ ),
          edges( edges_ )
    {
    }

    tri_mesh( const tri_mesh& o )
        : size_( o.size_ ),
          vertices_( o.vertices_ ),
          edges_( o.edges_ ),
          faces_( o.faces_ ),
          max_face_( o.max_face_ ),
          faces( faces_ ),
          edges( edges_ )
    {
    };

    tri_mesh& operator=( const tri_mesh& o )
    {
        size_     = o.size_;
        vertices_ = o.vertices_;
        edges_    = o.edges_;
        faces_    = o.faces_;
        max_face_ = o.max_face_;

        faces = detail::tri_mesh_face_container( faces_ );
        edges = detail::tri_mesh_edge_container( edges_ );

        return *this;
    };


    void clear( std::size_t s = 0 )
    {
        if ( s && ( s != size_ ) )
        {
            size_ = s;
            vertices_.resize( s );
        }

        vertices_.clear();
        edges_.clear();
        faces_.clear();
        max_face_ = 0;
    }

    void resize( std::size_t s )
    {
        size_ = s;
        vertices_.resize( s );
        clear();
    }

    uint32_t add_face( const uint32_t x, const uint32_t y, const uint32_t z )
    {

        ZI_ASSERT( x < size_ && y < size_ && z < size_ );

        ++max_face_;
        while ( faces_.count( max_face_ ) )
        {
            ++max_face_;
        }

        faces_.insert( std::make_pair( max_face_, face_type( x, y, z ) ) );

        add_edge( x, y, z, max_face_ );
        add_edge( y, z, x, max_face_ );
        add_edge( z, x, y, max_face_ );

        return max_face_;
    }

    void remove_face( const uint32_t id )
    {
        ZI_ASSERT( faces_.count( id ) );

        const face_type& f = faces_[ id ];

        remove_edge( f.v0(), f.v1(), id );
        remove_edge( f.v1(), f.v2(), id );
        remove_edge( f.v2(), f.v0(), id );

        faces_.erase( id );
    }

    void remove_face( const face_type& f )
    {
        remove_face( f.v0(), f.v1(), f.v2() );
    }

    void remove_face( const uint32_t x, const uint32_t y, const uint32_t z )
    {
        static_cast< void >( z );
        unordered_map< uint64_t, edge_type >::const_iterator it =
            edges_.find( detail::make_edge( x, y ) );

        ZI_ASSERT( it != edges_.end() );
        ZI_ASSERT( it->second.vertex_ == z );

        remove_face( it->second.face_ );

        ZI_ASSERT( edges_.count( detail::make_edge( x, y ) ) == 0 );
        ZI_ASSERT( edges_.count( detail::make_edge( y, z ) ) == 0 );
        ZI_ASSERT( edges_.count( detail::make_edge( z, x ) ) == 0 );
    }

    uint64_t vertex_edge( const uint32_t id ) const
    {
        if ( vertices_[ id ].on_border() )
        {
            return 0;
        }

        unordered_map< uint32_t, face_type >::const_iterator it = faces_.find( vertices_[ id ].face_ );

        if ( it == faces_.end() )
        {
            return 0;
        }

        return it->second.edge_from( id );
    }

    uint32_t across_edge( const uint64_t eid ) const
    {
        ZI_ASSERT( edges_.count( eid ) );
        return edges_.find( eid )->second.vertex_;
    }

    uint32_t across_edge( const uint32_t v0, const uint32_t v1 ) const
    {
        ZI_ASSERT( edges_.count( detail::make_edge( v0, v1 ) ) );
        return edges_.find( detail::make_edge( v0, v1 ) )->second.vertex_;
    }

    uint64_t next_edge( const uint64_t eid ) const
    {
        unordered_map< uint64_t, edge_type >::const_iterator it = edges_.find( eid );

        if ( it == edges_.end() )
        {
            return 0;
        }

        return ( ( eid << 32 ) | ( ~it->second.vertex_ ) );
    }

    uint64_t next_around( const uint64_t eid ) const
    {
        unordered_map< uint64_t, edge_type >::const_iterator it = edges_.find( eid );
        return ( it == edges_.end() ) ? 0 : ( ( eid | 0xffffffffLL ) ^ it->second.vertex_ );
    }

    uint64_t next_around_ccw( const uint64_t eid ) const
    {
        return next_edge( detail::edge_inverse( eid ) );
    }

    uint64_t next_around_cw( const uint64_t eid ) const
    {
        unordered_map< uint64_t, edge_type >::const_iterator it = edges_.find( eid );
        return ( it == edges_.end() ) ? 0 : ( ( eid | 0xffffffffLL ) ^ it->second.vertex_ );
    }

    bool valid_vertex( const uint32_t id ) const
    {
        return vertices_[ id ].valid() && !vertices_[ id ].on_border();
    }

    bool valid_edge( const uint64_t eid ) const
    {
        const uint32_t src = detail::edge_source( eid );
        const uint32_t snk = detail::edge_sink( eid );
        return
            vertices_[ src ].valid() &&
            vertices_[ snk ].valid() &&
            !vertices_[ src ].on_border() &&
            !vertices_[ snk ].on_border();
    }

    bool valid_edge( const uint32_t v1, const uint32_t v2 ) const
    {
        return valid_edge( detail::make_edge( v1, v2 ) );
    }

    uint64_t edge_pair( const uint64_t eid ) const
    {
        return detail::edge_inverse( eid );
    }

    uint32_t edge_face( const uint64_t eid ) const
    {
        unordered_map< uint64_t, edge_type >::const_iterator it = edges_.find( eid );

        if ( it == edges_.end() )
        {
            return 0;
        }

        return it->second.face_;
    }

    uint32_t collapse_edge( uint64_t eind )
    {
        uint32_t v1 = detail::edge_source( eind );
        uint32_t v2 = detail::edge_sink( eind );

        ZI_ASSERT( valid_edge( eind ) );
        ZI_ASSERT( vertices_[ v1 ].valid() && vertices_[ v2 ].valid() );

        uint64_t einv = detail::edge_inverse( eind );

        if ( vertices_[ v1 ].on_border() )
        {
            ZI_ASSERT_0( vertices_[ v2 ].on_border() );
            std::swap( v1, v2 );
            std::swap( einv, eind );
        }

        const edge_type& er = edges_.find( eind )->second;
        const edge_type& el = edges_.find( einv )->second;

        const uint32_t vr = er.vertex_;
        const uint32_t vl = el.vertex_;

        ZI_ASSERT( vr != vl );

        remove_face( er.face_ );
        remove_face( el.face_ );

        for ( uint32_t v = vr; v != vl; )
        {
            const uint64_t   e   = detail::make_edge( v1, v );
            const edge_type& edg = edges_.find( e )->second;
            const uint32_t   nv  = edg.vertex_;

            remove_face( edg.face_ );
            add_face( v2, v, nv );
            v = nv;
        }

        return v2;
    }

    uint32_t collapse_edge( const uint32_t x, const uint32_t y )
    {
        return collapse_edge( detail::make_edge( x, y ) );
    }

    std::size_t edge_count() const
    {
        return edges_.size();
    }

    std::size_t face_count() const
    {
        return faces_.size();
    }

    std::size_t vertex_count() const
    {
        return vertices_.size();
    }

    std::size_t size() const
    {
        return size_;
    }

    bool check_rep() const
    {

        if ( edges_.size() != faces_.size() * 3 )
        {
            ZI_THROW( "check_rep: extra edges present" );
        }

        FOR_EACH( it, faces_ )
        {
            if ( !( vertices_[ it->second.v0() ].valid() &&
                    vertices_[ it->second.v1() ].valid() &&
                    vertices_[ it->second.v2() ].valid() ) )
            {
                ZI_THROW( "check_rep: invalid vertex found" );
            }

            if ( ( edges_.find( it->second.e0() )->second ).face() != it->first ||
                 ( edges_.find( it->second.e1() )->second ).face() != it->first ||
                 ( edges_.find( it->second.e2() )->second ).face() != it->first )
            {
                ZI_THROW( "check_rep: edge doesn't link to the correct face" );
            }

            if ( !( edges_.count( it->second.e0() ) &&
                    edges_.count( it->second.e1() ) &&
                    edges_.count( it->second.e2() ) ) )
            {
                ZI_THROW( "check_rep: face missing an edge" );
            }
        }

        return true;
    }

    bool is_closed_surface() const
    {
        if ( edges_.size() != faces_.size() * 3 )
        {
            return false;
        }

        //FOR_EACH( it, vertices_ )
        //{
        //if ( !it->valid() || it->on_border() )
        //{
        //return false;
        //}
        //}

        FOR_EACH( it, edges_ )
        {
            if ( !edges_.count( detail::edge_inverse( it->first ) ) )
            {
                return false;
            }
            if ( vertices_[ detail::edge_source( it->first ) ].on_border() ||
                 vertices_[ detail::edge_sink  ( it->first ) ].on_border() )
            {
                return false;
            }
            if ( !vertices_[ detail::edge_source( it->first ) ].valid() ||
                 !vertices_[ detail::edge_sink  ( it->first ) ].valid() )
            {
                return false;
            }
        }

        FOR_EACH( it, faces_ )
        {
            if ( !( vertices_[ it->second.v0() ].valid() &&
                    vertices_[ it->second.v1() ].valid() &&
                    vertices_[ it->second.v2() ].valid() ) )
            {
                return false;
            }

            if ( !( edges_.count( it->second.e0() ) &&
                    edges_.count( it->second.e1() ) &&
                    edges_.count( it->second.e2() ) ) )
            {
                return false;
            }
        }

        return true;

    }

    void print_faces() const
    {
        FOR_EACH( it, faces_ )
        {
            std::cout << "f: "
                      << it->second.v0() << ','
                      << it->second.v1() << ','
                      << it->second.v2() << '\n';
        }
    }

    bool has_edge( const uint32_t v0, const uint32_t v1 ) const
    {
        return edges_.count( detail::make_edge( v0, v1 ) );
    }

    template< typename T >
    std::size_t get_faces( std::vector<T>& r )
    {
        r.resize(faces_.size());
        std::size_t i = 0;
        FOR_EACH( it, faces_ )
        {
            r[i++] = T(it->second.v0(), it->second.v1(), it->second.v2());
        }
        return r.size();
    }


    std::size_t stripify() const
    {
        return 0;
    }

};

} // namespace mesh
} // namespace zi

#endif
