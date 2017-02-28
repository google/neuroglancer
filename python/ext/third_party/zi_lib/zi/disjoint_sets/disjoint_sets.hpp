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

#ifndef ZI_DISJOINT_SETS_DISJOINT_SETS_HPP
#define ZI_DISJOINT_SETS_DISJOINT_SETS_HPP 1

#include <zi/config/config.hpp>
#include <zi/bits/type_traits.hpp>
#include <zi/bits/cstdint.hpp>
#include <zi/utility/enable_if.hpp>
#include <zi/utility/assert.hpp>
#include <zi/utility/detail/empty_type.hpp>

#include <cstddef>
#include <cassert>
#include <cstring>
#include <cstdlib>
#include <iostream>

namespace zi {

template< class T >
class disjoint_sets:
        enable_if< is_integral< T >::value, detail::empty_type >::type
{

private:
    T        *p_;
    uint8_t  *r_;
    T         size_ ;
    T         sets_ ;

    void init( T s )
    {
        ZI_ASSERT( s >= 0 );
        p_ = reinterpret_cast< T* >( malloc( s * sizeof( T ) ));
        r_ = reinterpret_cast< uint8_t* >( malloc( s * sizeof( uint8_t ) ));

        for ( T i = 0; i < s; ++i )
        {
            p_[ i ] = i;
            r_[ i ] = 0;
        }
        size_ = sets_ = s;
    }

public:

    explicit disjoint_sets( const T& s = 0 ): p_( 0 ), r_( 0 ), size_( 0 ), sets_( 0 )
    {
        if ( s > 0 )
        {
            init( s );
        }
    }

    ~disjoint_sets()
    {
        if ( p_ )
        {
            free( p_ );
        }
        if ( r_ )
        {
            free( r_ );
        }
    }

    inline T find_set( const T& id ) const
    {
        ZI_ASSERT( id < size_ );
        T i( id ), n( id ), x;

        while ( n != p_[ n ] )
        {
            n = p_[ n ];
        }

        while ( n != i )
        {
            x = p_[ id ];
            p_[ id ] = n;
            i = x;
        }

        return n;
    }

    inline T operator[]( const T& id ) const
    {
        return find_set( id );
    }

    inline T join( const T& x, const T& y )
    {
        ZI_ASSERT( x < size_ && x >= 0 );
        ZI_ASSERT( y < size_ && y >= 0 );

        if ( x == y )
        {
            return x;
        }

        --sets_;

        if ( r_[ x ] >= r_[ y ] )
        {
            p_[ y ] = x;
            if ( r_[ x ] == r_[ y ] )
            {
                ++r_[ x ];
            }
            return x;
        }

        p_[ x ] = y;
        return y;
    }

    inline T operator()( const T& x, const T& y )
    {
        return join( x, y );
    }

    inline void clear()
    {
        for ( T i = 0; i < size_; ++i )
        {
            p_[ i ] = i;
            r_[ i ] = 0;
        }
        sets_ = size_;
    }

    inline void resize( const T& s )
    {
        if ( s != size_ )
        {
            if ( size_ )
            {
                free( p_ );
                free( r_ );
            }
            init( s );
        }
        else
        {
            clear();
        }
    }

    T size() const
    {
        return size_;
    }

    T set_count() const
    {
        return sets_;
    }

};

} // namespace zi

#endif
