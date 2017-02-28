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

#ifndef ZI_HEAP_DETAIL_BINARY_HEAP_IMPL_HPP
#define ZI_HEAP_DETAIL_BINARY_HEAP_IMPL_HPP 1

#include <zi/bits/ref.hpp>
#include <zi/utility/exception.hpp>

#include <cstddef>
#include <vector>
#include <functional>

namespace zi {
namespace heap {
namespace detail {

template< class Type,
          class KeyType,
          class ValueType,
          class KeyExtractor,
          class ValueExtractor,
          class ValueCompare,
          class Container,
          class Allocator
          >
class binary_heap_impl
{
private:
    KeyExtractor         key_extractor_  ;
    ValueExtractor       value_extractor_;
    ValueCompare         compare_        ;
    Allocator            allocator_      ;

    std::vector< Type* > heap_           ;
    Container            container_      ;

public:
    binary_heap_impl( const ValueCompare& compare   = ValueCompare(),
                      const Allocator   & allocator = Allocator() )
        : key_extractor_(),
          value_extractor_(),
          compare_( compare ),
          allocator_( allocator ),
          heap_(),
          container_()
    {
    }

    inline std::size_t size() const
    {
        return heap_.size();
    }

    inline bool empty() const
    {
        return heap_.empty();
    }

    inline std::size_t count( const Type& v ) const
    {
        return container_.count( key_extractor_( const_cast< Type& >( v ) ) );
    }

    inline std::size_t key_count( const KeyType& v ) const
    {
        return container_.count( v );
    }

    inline const Type& top() const
    {
        if ( heap_.size() == 0 )
        {
            throw ::zi::exception( "called pop on an empty heap" );
        }
        return *heap_.front();
    }

    inline Type& top()
    {
        if ( heap_.size() == 0 )
        {
            throw ::zi::exception( "called pop on an empty heap" );
        }
        return *heap_.front();
    }

    inline void insert( const Type& v )
    {
        if ( !count( v ) )
        {
            insert_( v );
        }
    }

    inline std::size_t erase( const Type& v )
    {
        if ( count( v ) )
        {
            erase_( v );
            return 1;
        }
        return 0;
    }

    inline std::size_t erase_key( const KeyType& v )
    {
        if ( key_count( v ) )
        {
            erase_( *heap_[ container_[ v ] ] );
            return 1;
        }
        return 0;
    }

    inline void pop()
    {
        if ( heap_.size() > 0 )
        {
            erase_( *heap_.front() );
        }
    }

    inline void clear()
    {
        clear_();
    }


private:

    inline void swap_elements( std::size_t x, std::size_t y )
    {
        std::swap( heap_[ x ], heap_[ y ] );
        container_[ key_extractor_( heap_[ x ] ) ] = x;
        container_[ key_extractor_( heap_[ y ] ) ] = y;
    }

    inline void heap_up( std::size_t index )
    {
        std::size_t parent = ( index - 1 ) / 2;
        while ( index > 0 && compare_( value_extractor_( heap_[ index ] ),
                                       value_extractor_( heap_[ parent ] ) ) )
        {
            swap_elements( index, parent );
            index = parent;
            parent = ( index - 1 ) / 2;
        }
    }

    inline void heap_down( std::size_t index )
    {
        std::size_t child = index * 2 + 1;
        while ( child < heap_.size() )
        {
            if ( child + 1 < heap_.size() &&
                 compare_( value_extractor_( heap_[ child + 1 ] ),
                           value_extractor_( heap_[ child ] ) ) )
            {
                ++child;
            }

            if ( compare_( value_extractor_( heap_[ index ] ),
                           value_extractor_( heap_[ child ] ) ) )
            {
                break;
            }

            swap_elements( index, child );
            index = child;
            child = index * 2 + 1;
        }
    }

    inline void insert_( const Type& v )
    {
        Type *ptr = allocator_.allocate( 1 );
        allocator_.construct( ptr, v );

        container_.insert( std::make_pair( key_extractor_( ptr ), heap_.size() ) );
        heap_.push_back( ptr );

        heap_up( heap_.size() - 1 );
    }

    inline void erase_tail_()
    {
        container_.erase( key_extractor_( heap_.back() ) );
        allocator_.destroy( heap_.back() );
        allocator_.deallocate( heap_.back(), 1 );
        heap_.pop_back();
    }

    inline void clear_()
    {
        for ( typename std::vector< Type* >::iterator it = heap_.begin();
              it != heap_.end(); ++it )
        {
            allocator_.destroy( *it );
            allocator_.deallocate( *it, 1 );
        }
        heap_.clear();
        container_.clear();
    }

    inline void erase_( const Type& v )
    {
        std::size_t pos = container_[ key_extractor_( const_cast< Type&> ( v ) ) ];

        if ( pos + 1 == heap_.size() )
        {
            erase_tail_();
        }
        else
        {
            swap_elements( pos, heap_.size() - 1 );
            erase_tail_();
            heap_down( pos );
        }
    }

};

} // namespace detail
} // namespace heap
} // namespace zi


#endif
