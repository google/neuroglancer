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

#ifndef ZI_MESH_TRI_STRIPPER_HPP
#define ZI_MESH_TRI_STRIPPER_HPP 1

#include <zi/mesh/tri_mesh.hpp>
#include <zi/heap/binary_heap.hpp>

namespace zi {
namespace mesh {

class tri_stripper_impl
{
private:
    static const uint32_t face_mask = 0xfffffffc;

    static inline uint32_t face_of( uint32_t e )
    {
        return e & face_mask;
    }

    static inline uint32_t next_ccw( uint32_t e )
    {
        static const uint32_t map_helper[ 4 ] = { 0, 2, 3, 1 };
        return ( e & face_mask ) + map_helper[ e & 3 ];
    }

    static inline uint32_t next_cw( uint32_t e )
    {
        static const uint32_t map_helper[ 4 ] = { 0, 3, 1, 2 };
        return ( e & face_mask ) + map_helper[ e & 3 ];
    }

    inline uint32_t is_valid( uint32_t w ) const
    {
        return ( meta_[ w ] & 1 );
    }

    inline uint32_t is_valid( uint32_t f, uint32_t i ) const
    {
        return ( meta_[ f | i ] & 1 );
    }

    inline void unvalidate( uint32_t w )
    {
        meta_[ w ] &= 0xfe;
    }

    inline void use_edge( uint32_t f, uint32_t e )
    {
        meta_[ f ] += 0x10;
        meta_[ f ] |= ( static_cast< uint8_t >( 1 ) << e );
    }

    inline uint32_t degree( uint32_t f ) const
    {
        return ( meta_[ f ] >> 4 );
    }

    inline void set_degree( uint32_t f, uint8_t v )
    {
        meta_[ f ] &= 0x0f;
        meta_[ f ] |= ( v << 4 );
    }

    std::vector< uint32_t >   pair_      ;
    std::vector< uint8_t  >   meta_      ; // 0000 000x - validity
                                           // 0000 xxx0 - used edges map
                                           // 00xx 0000 - num used edges
    struct face_data
    {
        uint32_t v[ 3 ];
    };

    std::vector< face_data >  face_data_ ;
    std::size_t               size_      ;

    struct heap_entry
    {
        uint32_t face_ ;
        uint32_t value_;

        explicit heap_entry( uint32_t f, uint32_t v )
            : face_( f ), value_( v )
        {
        }

    };

    typedef binary_heap<
        heap_entry,
        zi::heap::hashed_index<
            zi::heap::member_variable<
                heap_entry,
                uint32_t,
                &heap_entry::face_
            >
        >,

        zi::heap::value<
            zi::heap::member_variable<
                heap_entry,
                uint32_t,
                &heap_entry::value_
            >,
            std::less< uint32_t >
        >
    > heap_type;

    heap_type heap_;

    inline uint32_t value_of( uint32_t f ) const
    {
        uint32_t v = is_valid( f | 1 ) + is_valid( f | 2 ) + is_valid( f | 3 );
        v <<= 1;

        if ( pair_[ f ] != f )
        {
            if ( v > 0 )
            {
                ++v;
            }
        }
        return v;
    }

    void add_to_heap( uint32_t f )
    {
        if ( is_valid( f ) )
        {
            uint32_t v = value_of( f );
            if ( v > 0 )
            {
                heap_.insert( heap_entry( f, v ) );
            }
        }
    }

    void update_heap( uint32_t f )
    {
        heap_.erase_key( f );
        add_to_heap( f );
    }

    void detach_face( uint32_t f )
    {
        unvalidate( f );
        for ( uint32_t i = 0; i < 3; ++i )
        {
            ++f;
            if ( is_valid( f ) )
            {
                unvalidate( f );
                unvalidate( pair_[ f ] );
                update_heap( pair_[ f ] );
            }
        }
    }

    void apply_edge( uint32_t f1, uint32_t idx )
    {
        uint32_t e1 = f1 | idx;
        uint32_t e2 = pair_[ e1 ];
        uint32_t f2 = face_of( e2 );

        use_edge( f1, e1 & 3 );
        use_edge( f2, e2 & 3 );

        unvalidate( e1 );
        unvalidate( e2 );

        if ( pair_[ f1 ] != f1 )
        {
            detach_face( f1 );
        }

        if ( pair_[ f2 ] != f2 )
        {
            detach_face( f2 );
        }

        uint32_t tmp = pair_[ f2 ];
        pair_[ pair_[ f2 ] ] = pair_[ f1 ];
        pair_[ pair_[ f1 ] ] = tmp;

        update_heap( f1 );
        update_heap( f2 );
    }

    void iteration()
    {
        heap_entry t = heap_.top();
        heap_.pop();

        if ( t.value_ == 0 )
        {
            unvalidate( t.face_ );
        }
        else
        {
            for ( uint32_t i = 1; i < 4; ++i )
            {
                if ( is_valid( t.face_ | i ) )
                {
                    if ( pair_[ t.face_ ] != face_of( pair_[ t.face_ | i ] ) )
                    {
                        apply_edge( t.face_, i );
                        return;
                    }
                    else
                    {
                        unvalidate( t.face_ | i );
                        unvalidate( pair_[ t.face_ | i ] );
                    }
                }
            }
        }
    }

    inline void extract_strip( uint32_t f,
                               std::vector< uint32_t >& vertices,
                               std::vector< uint32_t >& strip_begins,
                               std::vector< uint32_t >& strip_lengths )
    {
        static const uint32_t edge_table[ 8 ] =
            {
                0, 1, 2, 1, 3, 1, 2, 1,
            };

        static const uint32_t circle_edge[ 4 ] =
            {
                0, 3, 1, 2
            };

        static const uint32_t expected_idx[ 2 ][ 4 ] =
        {
            { 0, 3, 1, 2 },
            { 0, 2, 3, 1 }
        };

        uint32_t start  = vertices.size();
        uint32_t length = 0;

        if ( degree( f ) == 0 )
        {

            vertices.push_back( face_data_[ f >> 2 ].v[ 0 ] );
            vertices.push_back( face_data_[ f >> 2 ].v[ 2 ] );
            vertices.push_back( face_data_[ f >> 2 ].v[ 1 ] );
            vertices.push_back( face_data_[ f >> 2 ].v[ 2 ] );
            strip_begins.push_back( start );
            strip_lengths.push_back( 4 );
            return;
        }

        if ( degree( f ) != 1 )
        {
            return;
        }

        set_degree( f, 2 );

        uint32_t ccw       = 0;
        uint32_t curr_face = f;
        uint32_t curr_edge = edge_table[ (( meta_[ f ] >> 1 ) & 0x7 ) ];

        for ( uint32_t i = 0; i < 3; ++i )
        {
            ++length;
            vertices.push_back( face_data_[ curr_face >> 2 ].v[ curr_edge - 1 ] );
            curr_edge = circle_edge[ curr_edge ];
        }


        uint32_t entr_edge = pair_[ curr_face | curr_edge ];
        curr_face = face_of( entr_edge );

        while ( degree( curr_face ) != 1 )
        {
            ccw = 1 - ccw;
            curr_edge = expected_idx[ ccw ][ entr_edge & 3 ];
            if ( ( meta_[ curr_face ] & ( 1 << curr_edge ) ) == 0 )
            {
                ++length;
                vertices.push_back( vertices[ vertices.size() - 2 ] );
                ccw = 1 - ccw;
                curr_edge = expected_idx[ ccw ][ entr_edge & 3 ];
                ZI_ASSERT( meta_[ curr_face ] & ( 1 << curr_edge ) );
            }

            ++length;
            vertices.push_back( face_data_[ curr_face >> 2 ].v[ ( entr_edge & 3 ) - 1 ] );

            entr_edge = pair_[ curr_face | curr_edge ];
            curr_face = face_of( entr_edge );
        }

        ++length;
        vertices.push_back( face_data_[ curr_face >> 2 ].v[ ( entr_edge & 3 ) - 1 ] );

        set_degree( curr_face, 2 );

        strip_lengths.push_back( length );
        strip_begins.push_back( start );

    }

public:
    explicit tri_stripper_impl( const tri_mesh& mesh )
        : pair_( mesh.face_count() * 4 ),
          meta_( mesh.face_count() * 4 ),
          face_data_( mesh.face_count() ),
          size_( mesh.face_count() ),
          heap_()
    {

        //std::cout << "TRI STRIPPER OF SIZE: " << size_ << "\n";

        std::fill_n( pair_.begin(), pair_.size(), 0 );
        std::fill_n( meta_.begin(), pair_.size(), 0 );

        unordered_map< uint64_t, uint32_t > edges;
        unordered_map< uint64_t, uint32_t >::const_iterator eit;

        uint32_t idx = 0;
        FOR_EACH( it, mesh.faces )
        {
            const uint32_t& v1 = it->v0();
            const uint32_t& v2 = it->v1();
            const uint32_t& v3 = it->v2();

            const uint32_t ioff = idx << 2;

            face_data_[ idx ].v[ 0 ] = v1;
            face_data_[ idx ].v[ 1 ] = v2;
            face_data_[ idx ].v[ 2 ] = v3;

            edges.insert( std::make_pair( detail::make_edge( v1, v2 ), ioff + 3 ));
            edges.insert( std::make_pair( detail::make_edge( v2, v3 ), ioff + 1 ));
            edges.insert( std::make_pair( detail::make_edge( v3, v1 ), ioff + 2 ));

            eit = edges.find( detail::make_edge( v2, v1 ) );
            if ( eit != edges.end() )
            {
                pair_[ ioff + 3 ] = eit->second;
                pair_[ eit->second ] = ioff + 3;
                meta_[ ioff + 3 ] = meta_[ eit->second ] = 1;
            }

            eit = edges.find( detail::make_edge( v3, v2 ) );
            if ( eit != edges.end() )
            {
                pair_[ ioff + 1 ] = eit->second;
                pair_[ eit->second ] = ioff + 1;
                meta_[ ioff + 1 ] = meta_[ eit->second ] = 1;
            }

            eit = edges.find( detail::make_edge( v1, v3 ) );
            if ( eit != edges.end() )
            {
                pair_[ ioff + 2 ] = eit->second;
                pair_[ eit->second ] = ioff + 2;
                meta_[ ioff + 2 ] = meta_[ eit->second ] = 1;
            }

            pair_[ ioff ] = ioff;
            meta_[ ioff ] = 1;
            ++idx;

        }

    }

    std::size_t execute( std::vector< uint32_t >& vertices,
                         std::vector< uint32_t >& strip_begins,
                         std::vector< uint32_t >& strip_lengths )


    {
        vertices.clear();
        strip_begins.clear();
        strip_lengths.clear();


        for ( uint32_t i = 0; i < size_; ++i )
        {
            add_to_heap( i << 2 );
        }

        while ( heap_.size() > 0 )
        {
            iteration();
        }

        for ( uint32_t i = 0; i < size_; ++i )
        {
            uint32_t f = ( i << 2 );
            if ( degree( f ) < 2 )
            {
                extract_strip( f, vertices, strip_begins, strip_lengths );
            }
        }

        return strip_begins.size();
    }

};

} // namespace mesh
} // namespace zi

#endif
