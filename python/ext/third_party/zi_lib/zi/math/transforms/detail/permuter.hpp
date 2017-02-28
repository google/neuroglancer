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

#ifndef ZI_MATH_TRANSFORMS_DETAIL_PERMUTER_HPP
#define ZI_MATH_TRANSFORMS_DETAIL_PERMUTER_HPP 1

#include <zi/bits/type_traits.hpp>
#include <zi/bits/cstdint.hpp>
#include <zi/utility/assert.hpp>
#include <zi/utility/singleton.hpp>
#include <zi/utility/for_each.hpp>
#include <zi/utility/non_copyable.hpp>
#include <zi/utility/static_assert.hpp>
#include <zi/concurrency/mutex.hpp>

#include <complex>
#include <vector>
#include <cstddef>

namespace zi {
namespace math {
namespace detail {

template< std::size_t Size >
class permuter_impl: non_copyable
{
private:
    std::vector< std::pair< uint32_t, uint32_t > > pairs_   ;
    mutex                                          lock_    ;
    bool                                           computed_;

public:
    void compute()
    {
        mutex::guard g( lock_ );

        if ( computed_ )
        {
            return;
        }

        std::size_t actual_size = ( 1 << Size );

        std::vector< uint32_t > reversers( actual_size );

        for ( std::size_t i = 0; i < actual_size; ++i )
        {
            for ( std::size_t j = 0; j < Size; ++j )
            {
                if ( ( i & ( 1 << j ) ) )
                {
                    reversers[ i ] += ( 1 << ( Size - j - 1 ) );
                }
            }
        }

        for ( std::size_t i = 0; i < actual_size; ++i )
        {
            if ( i < reversers[ i ] )
            {
                pairs_.push_back( std::make_pair( i, reversers[ i ] ) );
            }
        }

        computed_ = true;

    }

    permuter_impl()
        : pairs_(),
          lock_(),
          computed_( false )
    {
    }

    template< class T >
    std::size_t operator()( std::vector< T >& data )
    {
        compute();

        FOR_EACH( it, pairs_ )
        {
            std::swap( data[ it->first ], data[ it->second ] );
        }
        return Size;
    }

    template< class T >
    std::size_t apply( std::vector< T >& data )
    {
        compute();

        FOR_EACH( it, pairs_ )
        {
            std::swap( data[ it->first ], data[ it->second ] );
        }
        return Size;
    }

    template< class T >
    std::size_t apply( T* data )
    {
        compute();

        FOR_EACH( it, pairs_ )
        {
            std::swap( data[ it->first ], data[ it->second ] );
        }
        return Size;
    }

};


template< class T, std::size_t S >
class permuter_applier;

template< class T >
class permuter_applier< T, 26 >: non_copyable
{
public:
    static inline const std::size_t apply( std::vector< T >& data )
    {
        data.clear();
        return 0;
    }

    static inline const std::size_t apply( T*, std::size_t )
    {
        return 0;
    }
};

template< class T, std::size_t S >
class permuter_applier: non_copyable
{
private:
    ZI_STATIC_ASSERT( S < 26, too_large_root_table );

public:
    static inline const std::size_t apply( std::vector< T >& data )
    {
        if ( data.size() <= ( 1 << S ) )
        {
            data.resize( 1 << S );
            return singleton< permuter_impl< S > >::instance().apply( data );
        }
        else
        {
            return permuter_applier< T, S+1 >::apply( data );
        }
    }

    static inline const std::size_t apply( T* data, std::size_t len )
    {
        if ( len <= ( 1 << S ) )
        {
            ZI_ASSERT( len == ( 1 << S ) );
            return singleton< permuter_impl< S > >::instance().apply( data );
        }
        else
        {
            return permuter_applier< T, S+1 >::apply( data, len );
        }
    }
};

template< class T >
inline const std::size_t apply_permutation( T* data, std::size_t len )
{
    return permuter_applier< T, 1 >::apply( data, len );
}

template< class T >
inline const std::size_t apply_permutation( std::vector< T >& data )
{
    return permuter_applier< T, 1 >::apply( data );
}

} // namespace detail
} // namespace math
} // namespace zi

#endif

