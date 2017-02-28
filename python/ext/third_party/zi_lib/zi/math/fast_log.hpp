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

#ifndef ZI_MATH_FAST_LOG_HPP
#define ZI_MATH_FAST_LOG_HPP 1

#include <zi/utility/enable_singleton_of_this.hpp>
#include <zi/bits/cstdint.hpp>

#include <cmath>

namespace zi {
namespace math {

namespace detail {

template< std::size_t N >
class fast_log_table
{
private:
    float table_[ 1 << N ];

public:
    fast_log_table()
    {
        table_[ 0 ] = std::log( 1.0f ) / 0.69314718055995f;

        float v = 1.0f + ( 1.0f / ( 1 << ( N + 1 ) ) );
        v += 1.0f / ( 1 << ( N ) );

        for( std::size_t i = 1; i < ( 1 << N ); ++i )
        {
            table_[ i ] = std::log( v ) / 0.69314718055995f;

            v += 1.0f / ( 1 << N );
        }
    }

    const float* get_table_ptr() const
    {
        return table_;
    }
};

} // namespace detail


template< std::size_t N >
inline float fast_log( const float val )
{
    static const float* const table =
        singleton< detail::fast_log_table< N > >::instance().get_table_ptr();

    register const int* ival = reinterpret_cast< const int* >
        ( &reinterpret_cast< const char& >( val ));

    return ( static_cast< float >( (( *ival >> 23 ) & 255 ) - 127 ) +
             table[ ( *ival & 0x7fffff ) >> ( 23 - N ) ] ) * 0.69314718055995f;
}

inline float fast_log( const float val )
{
    static const float* const table =
        singleton< detail::fast_log_table< 14 > >::instance().get_table_ptr();

    register const int* ival = reinterpret_cast< const int* >
        ( &reinterpret_cast< const char& >( val ));

    return ( static_cast< float >( (( *ival >> 23 ) & 255 ) - 127 ) +
             table[ ( *ival & 0x7fffff ) >> ( 23 - 14 ) ] ) * 0.69314718055995f;
}

inline float fast_approximate_log( const float val )
{
    static const float* const table =
        singleton< detail::fast_log_table< 7 > >::instance().get_table_ptr();

    register const int* ival = reinterpret_cast< const int* >
        ( &reinterpret_cast< const char& >( val ));

    return ( static_cast< float >( (( *ival >> 23 ) & 255 ) - 127 ) +
             table[ ( *ival & 0x7fffff ) >> ( 23 - 7 ) ] ) * 0.69314718055995f;
}



} // namespace math
} // namespace zi

#endif

