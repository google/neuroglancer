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

#ifndef ZI_MESH_TRI_MESH_FACE_HPP
#define ZI_MESH_TRI_MESH_FACE_HPP 1

#include <zi/bits/cstdint.hpp>
#include <zi/bits/unordered_map.hpp>
#include <zi/bits/ref.hpp>

#include <zi/utility/assert.hpp>
#include <zi/utility/enable_if.hpp>
#include <zi/utility/non_copyable.hpp>
#include <zi/utility/static_if.hpp>

#include <iterator>
#include <cstddef>

namespace zi {
namespace mesh {

// forward declaration
struct tri_mesh;

namespace detail {

struct tri_mesh_face_impl
{
private:
    uint32_t v_[ 3 ];

    static inline uint64_t make_edge( uint32_t x, uint32_t y )
    {
        return ( static_cast< uint64_t >( ~x ) << 32 ) | ( ~y );
    }

public:

    inline bool operator==( const tri_mesh_face_impl& o ) const
    {
        return std::equal( v_, v_ + 3, o.v_ );
    }

    inline bool operator!=( const tri_mesh_face_impl& o ) const
    {
        return !std::equal( v_, v_ + 3, o.v_ );
    }

    template< std::size_t Index >
    inline uint32_t vertex( typename enable_if<
                            ( Index < 3 ), ::zi::detail::dummy< Index >
                            >::type = 0 ) const
    {
        return v_[ Index ];
    }

    inline uint32_t v0() const
    {
        return v_[ 0 ];
    }

    inline uint32_t v1() const
    {
        return v_[ 1 ];
    }

    inline uint32_t v2() const
    {
        return v_[ 2 ];
    }

    inline uint64_t e0() const
    {
        return make_edge( v_[ 1 ], v_[ 2 ] );
    }

    inline uint64_t e1() const
    {
        return make_edge( v_[ 2 ], v_[ 0 ] );
    }

    inline uint64_t e2() const
    {
        return make_edge( v_[ 0 ], v_[ 1 ] );
    }

    inline uint64_t edge( std::size_t i )
    {
        ZI_ASSERT( i < 3 );
        return make_edge( v_[ i ], v_[ i == 2 ? 0 : i + 1 ] );
    }

    template< std::size_t Index >
    inline uint64_t edge( typename enable_if<
                          ( Index == 0 ), ::zi::detail::dummy< Index >
                          >::type = 0 ) const
    {
        return make_edge( v_[ 1 ], v_[ 2 ] );
    }

    template< std::size_t Index >
    inline uint64_t edge( typename enable_if<
                          ( Index == 1 ), ::zi::detail::dummy< Index >
                          >::type = 0 ) const
    {
        return make_edge( v_[ 2 ], v_[ 0 ] );
    }

    template< std::size_t Index >
    inline uint64_t edge( typename enable_if<
                          ( Index == 2 ), ::zi::detail::dummy< Index >
                          >::type = 0 ) const
    {
        return make_edge( v_[ 2 ], v_[ 0 ] );
    }

    inline uint64_t edge_from( uint32_t v ) const
    {
        if ( v == v_[ 0 ] )
        {
            return make_edge( v_[ 0 ], v_[ 1 ] );
        }

        if ( v == v_[ 1 ] )
        {
            return make_edge( v_[ 1 ], v_[ 2 ] );
        }

        if ( v == v_[ 2 ] )
        {
            return make_edge( v_[ 2 ], v_[ 0 ] );
        }

        return 0;
    }

    inline tri_mesh_face_impl()
    {
    }

    inline tri_mesh_face_impl( uint32_t x, uint32_t y, uint32_t z )
    {
        v_[ 0 ] = x;
        v_[ 1 ] = y;
        v_[ 2 ] = z;
    }

    friend struct tri_mesh;

private:

    inline void replace_vertex( uint32_t orig, uint32_t replacement )
    {
        if ( orig == v_[ 0 ] )
        {
            v_[ 0 ] = replacement;
            return;
        }

        if ( orig == v_[ 1 ] )
        {
            v_[ 1 ] = replacement;
            return;
        }

        if ( orig == v_[ 2 ] )
        {
            v_[ 2 ] = replacement;
            return;
        }

        ZI_VERIFY( 0 );
    }

};

struct tri_mesh_face_container
{
protected:
    reference_wrapper< unordered_map< uint32_t, tri_mesh_face_impl > > faces_;

    tri_mesh_face_container( unordered_map< uint32_t, tri_mesh_face_impl > &faces )
        : faces_( faces )
    {
    }

    friend struct ::zi::mesh::tri_mesh;

public:

    template< bool IsConst, bool IsReverse >
    struct iterator_base
    {
        typedef iterator_base< IsConst, IsReverse > iterator_type;
        typedef std::ptrdiff_t                      difference_type;
        typedef std::bidirectional_iterator_tag     iterator_category;
        typedef tri_mesh_face_impl                  value_type;
        typedef typename if_< IsConst,
                              const tri_mesh_face_impl*,
                              tri_mesh_face_impl* >::type pointer;
        typedef typename if_< IsConst,
                              const tri_mesh_face_impl&,
                              tri_mesh_face_impl& >::type reference;


        inline iterator_base()
            : i_()
        {
        }

        inline reference operator*() const
        {
            return i_->second;
        }

        inline pointer operator->() const
        {
            return &i_->second;
        }

        inline iterator_type& operator++()
        {
            ++i_;
            return *this;
        }

        inline iterator_type operator++( int )
        {
            iterator_type tmp = *this;
            ++i_;
            return tmp;
        }

        inline iterator_type& operator--()
        {
            --i_;
            return *this;
        }

        inline iterator_type operator--( int )
        {
            iterator_type tmp = *this;
            --i_;
            return tmp;
        }

        template< bool B >
        inline bool operator==( const iterator_base< B, IsReverse >& o )
        {
            return i_ == o.i_;
        }

        template< bool B >
        inline bool operator!=( const iterator_base< B, IsReverse >& o )
        {
            return i_ != o.i_;
        }

        inline uint32_t id() const
        {
            return i_->first;
        }

        inline operator uint32_t() const
        {
            return i_->first;
        }

        template< std::size_t Index >
        inline uint32_t vertex( typename enable_if<
                                ( Index < 3 ), ::zi::detail::dummy< Index >
                                >::type = 0 ) const
        {
            return i_->second.template vertex< Index >();
        }

        inline uint32_t v0() const
        {
            return i_->second.v0();
        }

        inline uint32_t v1() const
        {
            return i_->second.v1();
        }

        inline uint32_t v2() const
        {
            return i_->second.v2();
        }

        inline uint64_t e0() const
        {
            return i_->second.e0();
        }

        inline uint64_t e1() const
        {
            return i_->second.e1();
        }

        inline uint64_t e2() const
        {
            return i_->second.e2();
        }

        inline uint64_t edge( std::size_t i )
        {
            return i_->second.edge( i );
        }

        template< std::size_t Index >
        inline uint64_t edge( typename enable_if<
                              ( Index < 3 ), ::zi::detail::dummy< Index >
                              >::type = 0 ) const
        {
            return i_->second.template edge< Index >();
        }

        inline uint64_t edge_from( uint32_t v ) const
        {
            return i_->second.edge_from( v );
        }

        friend struct tri_mesh_face_container;

    private:
        typedef typename if_< IsConst,
                              unordered_map< uint32_t, tri_mesh_face_impl >::const_iterator,
                              unordered_map< uint32_t, tri_mesh_face_impl >::iterator
                              >::type base_forward_type;

        typedef std::reverse_iterator< base_forward_type > base_backward_type;

        typedef typename if_< IsReverse, base_backward_type, base_forward_type >::type base_type;

        base_type i_;

        explicit iterator_base( const base_forward_type& i )
            : i_( i )
        {
        }
    };

    typedef iterator_base< false, false >::iterator_type  iterator;
    typedef iterator_base< true , false >::iterator_type  const_iterator;
    typedef iterator_base< false, true  >::iterator_type  reverse_iterator;
    typedef iterator_base< true , true  >::iterator_type  const_reverse_iterator;

    inline iterator find( uint32_t id )
    {
        return iterator( faces_.get().find( id ) );
    }

    inline const_iterator find( uint32_t id ) const
    {
        return const_iterator( faces_.get().find( id ) );
    }

    inline iterator begin()
    {
        return iterator( faces_.get().begin() );
    }

    inline iterator end()
    {
        return iterator( faces_.get().end() );
    }

    inline const_iterator begin() const
    {
        return const_iterator( faces_.get().begin() );
    }

    inline const_iterator end() const
    {
        return const_iterator( faces_.get().end() );
    }

    inline reverse_iterator rbegin()
    {
        return reverse_iterator( faces_.get().end() );
    }

    inline reverse_iterator rend()
    {
        return reverse_iterator( faces_.get().begin() );
    }

    inline const_reverse_iterator rbegin() const
    {
        return const_reverse_iterator( faces_.get().end() );
    }

    inline const_reverse_iterator rend() const
    {
        return const_reverse_iterator( faces_.get().begin() );
    }

};

} // namespace detail
} // namespace mesh
} // namespace zi

#endif
