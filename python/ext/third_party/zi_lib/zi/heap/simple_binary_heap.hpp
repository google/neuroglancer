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

#ifndef ZI_HEAP_SIMPLE_BINARY_HEAP_HPP
#define ZI_HEAP_SIMPLE_BINARY_HEAP_HPP

#include <zi/bits/hash.hpp>
#include <zi/bits/unordered_map.hpp>
#include <zi/utility/exception.hpp>

#include <functional>
#include <cstring>
#include <cstdlib>
#include <cstddef>
#include <vector>

#include <zi/detail/identity.hpp>
#include <zi/detail/member_function.hpp>
#include <zi/detail/member_variable.hpp>
#include <zi/detail/global_function.hpp>

namespace zi {

template< class Heapable,
          class Compare = std::less< Heapable >,
          class Hash    = hash< Heapable >,
          class Pred    = std::equal_to< Heapable >,
          class Alloc   = std::allocator< Heapable > >
class simple_binary_heap
{
public:

    typedef Heapable                   heapable_type;
    typedef Compare                    heapable_compare;
    typedef Hash                       hasher;
    typedef Pred                       heapable_equal;
    typedef Alloc                      allocator_type;
    typedef typename Alloc::size_type  size_type;

private:

    typedef typename allocator_type::template rebind<
        std::pair< const Heapable, std::size_t >
    >::other hash_map_alloc;

    typedef unordered_map< Heapable, std::size_t, Hash, Pred, hash_map_alloc >  hash_map_type;
    typedef std::vector< Heapable, Alloc >                                      storage_type ;

    hash_map_type    hash_map_;
    storage_type     storage_ ;
    heapable_compare compare_ ;

public:

    simple_binary_heap( const heapable_compare& c = heapable_compare(),
                        const hasher& h = hasher(),
                        const heapable_equal& p = heapable_equal(),
                        const allocator_type& a = allocator_type() )
        : hash_map_( 10, h, p, a ),
          storage_( a ),
          compare_( c )
    {
    }

    std::size_t size() const
    {
        return storage_.size();
    }

    const heapable_type& top() const
    {
        if ( storage_.size() == 0 )
        {
            throw ::zi::exception( "called pop on an empty heap" );
        }
        return storage_.front();
    }

    heapable_type& top()
    {
        if ( storage_.size() == 0 )
        {
            throw ::zi::exception( "called pop on an empty heap" );
        }
        return storage_.front();
    }

    std::size_t count( const heapable_type& v ) const
    {
        return hash_map_.count( v );
    }

    bool empty() const
    {
        return storage_.empty();
    }

    void insert( const heapable_type& v )
    {
        if ( !count( v ) )
        {
            insert_( v );
        }
    }

    std::size_t erase( const heapable_type& v )
    {
        if ( count( v ) )
        {
            erase_( v );
            return 1;
        }
        return 0;
    }

    void pop()
    {
        if ( storage_.size() > 0 )
        {
            erase_( storage_.front() );
        }
    }

private:

    void swap_elements( std::size_t x, std::size_t y )
    {
        std::swap( storage_[ x ], storage_[ y ] );
        hash_map_[ storage_[ x ] ] = x;
        hash_map_[ storage_[ y ] ] = y;
    }

    void heap_up( std::size_t index )
    {
        std::size_t parent = ( index - 1 ) / 2;
        while ( index > 0 && compare_( storage_[ index ], storage_[ parent ] ) )
        {
            swap_elements( index, parent );
            index = parent;
            parent = ( index - 1 ) / 2;
        }
    }

    void heap_down( std::size_t index )
    {
        std::size_t child = index * 2 + 1;
        while ( child < storage_.size() )
        {
            if ( child + 1 < storage_.size() &&
                 compare_( storage_[ child + 1 ], storage_[ child ] ) )
            {
                ++child;
            }

            if ( compare_( storage_[ index ], storage_[ child ] ) )
            {
                break;
            }

            swap_elements( index, child );
            index = child;
            child = index * 2 + 1;
        }
    }

    void insert_( const heapable_type& v )
    {
        hash_map_.insert( std::make_pair( v, storage_.size() ) );
        storage_.push_back( v );
        heap_up( storage_.size() - 1 );
    }

    void erase_( const heapable_type& v )
    {
        std::size_t pos = hash_map_[ v ];
        if ( pos + 1 == storage_.size() )
        {
            hash_map_.erase( v );
            storage_.pop_back();
        }
        else
        {
            swap_elements( pos, storage_.size() - 1 );
            hash_map_.erase( storage_.back() );
            storage_.pop_back();
            heap_down( pos );
        }
    }

};

} // namespace zi

#endif

