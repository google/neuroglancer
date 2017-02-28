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

#ifndef ZI_MESH_TRI_MESH_EDGE_HPP
#define ZI_MESH_TRI_MESH_EDGE_HPP 1

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

struct tri_mesh_edge_impl
{
private:
    const uint32_t face_  ;
    const uint32_t vertex_;

    friend struct ::zi::mesh::tri_mesh;

public:
    tri_mesh_edge_impl()
        : face_( 0 ), vertex_( 0 )
    {
    }

    tri_mesh_edge_impl( uint32_t f, uint32_t v )
        : face_( f ), vertex_( v )
    {
    }

    tri_mesh_edge_impl(const tri_mesh_edge_impl& tri) 
        : face_( tri.face() ), vertex_( tri.vertex() )
    {
    }

    inline bool operator==( const tri_mesh_edge_impl& o ) const
    {
        return face_ == o.face_ && vertex_ == o.vertex_;
    }

    inline bool operator!=( const tri_mesh_edge_impl& o ) const
    {
        return !( *this == o );
    }

    inline const tri_mesh_edge_impl* operator=( const tri_mesh_edge_impl& o ) const
    {
        return this;
    }

    uint32_t face() const
    {
        return face_;
    }

    uint32_t vertex() const
    {
        return vertex_;
    }
};

struct tri_mesh_edge_container
{
protected:
    reference_wrapper< unordered_map< uint64_t, tri_mesh_edge_impl > > edges_;

    tri_mesh_edge_container( unordered_map< uint64_t, tri_mesh_edge_impl > &edges )
        : edges_( edges )
    {
    }

    friend struct ::zi::mesh::tri_mesh;

public:

    template< bool IsConst, bool IsReverse >
    struct iterator_base
    {
    private:
        static inline uint32_t edge_source( uint64_t e )
        {
            return ( static_cast< uint32_t >( ~e >> 32 ) );
        }

        static inline uint32_t edge_sink( uint64_t e )
        {
            return ( static_cast< uint32_t >( ~e & 0x7fffffff ) );
        }

        static inline uint64_t edge_inverse( uint64_t e )
        {
            return ( e >> 32 ) | ( e << 32 );
        }


    public:
        typedef iterator_base< IsConst, IsReverse > iterator_type;
        typedef std::ptrdiff_t                      difference_type;
        typedef std::bidirectional_iterator_tag     iterator_category;
        typedef tri_mesh_edge_impl                  value_type;
        typedef typename if_< IsConst,
                              const tri_mesh_edge_impl*,
                              tri_mesh_edge_impl* >::type pointer;
        typedef typename if_< IsConst,
                              const tri_mesh_edge_impl&,
                              tri_mesh_edge_impl& >::type reference;


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

        inline uint64_t id() const
        {
            return i_->first;
        }

        inline operator uint64_t() const
        {
            return i_->first;
        }

        inline uint32_t face() const
        {
            return i_->second.face();
        }

        inline uint32_t v2() const
        {
            return i_->second.vertex();
        }

        inline uint32_t vertex() const
        {
            return i_->second.vertex();
        }

        inline uint32_t source() const
        {
            return edge_source( i_->first );
        }

        inline uint32_t sink() const
        {
            return edge_sink( i_->first );
        }

        inline uint32_t v0() const
        {
            return edge_source( i_->first );
        }

        inline uint32_t v1() const
        {
            return edge_sink( i_->first );
        }

        inline uint64_t pair() const
        {
            return edge_inverse( i_->first );
        }

        friend struct tri_mesh_edge_container;

    private:
        typedef typename if_< IsConst,
                              unordered_map< uint64_t, tri_mesh_edge_impl >::const_iterator,
                              unordered_map< uint64_t, tri_mesh_edge_impl >::iterator
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

    inline iterator find( uint64_t id )
    {
        return iterator( edges_.get().find( id ) );
    }

    inline const_iterator find( uint64_t id ) const
    {
        return const_iterator( edges_.get().find( id ) );
    }

    inline iterator begin()
    {
        return iterator( edges_.get().begin() );
    }

    inline iterator end()
    {
        return iterator( edges_.get().end() );
    }

    inline const_iterator begin() const
    {
        return const_iterator( edges_.get().begin() );
    }

    inline const_iterator end() const
    {
        return const_iterator( edges_.get().end() );
    }

    inline reverse_iterator rbegin()
    {
        return reverse_iterator( edges_.get().end() );
    }

    inline reverse_iterator rend()
    {
        return reverse_iterator( edges_.get().begin() );
    }

    inline const_reverse_iterator rbegin() const
    {
        return const_reverse_iterator( edges_.get().end() );
    }

    inline const_reverse_iterator rend() const
    {
        return const_reverse_iterator( edges_.get().begin() );
    }

};

} // namespace detail
} // namespace mesh
} // namespace zi

#endif
