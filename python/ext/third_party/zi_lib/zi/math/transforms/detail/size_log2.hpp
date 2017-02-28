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

#ifndef ZI_MATH_TRANSFORMS_DETAIL_SIZE_LOG2_HPP
#define ZI_MATH_TRANSFORMS_DETAIL_SIZE_LOG2_HPP 1

#include <zi/bits/type_traits.hpp>
#include <zi/utility/static_assert.hpp>
#include <zi/utility/assert.hpp>

#include <limits>
#include <cstddef>

namespace zi {
namespace math {
namespace detail {


template< class T >
std::size_t size_log2( T x )
{
    ZI_STATIC_ASSERT( is_integral< T >::value, non_integral_value_given );
    ZI_ASSERT( x > 0 );

    std::size_t t = integral_constant< std::size_t, sizeof( T ) >::value * 4;
    std::size_t r = 0;

    if ( x & ( x-1 ) )
    {
        ++r;
    }

    while ( x != 1 )
    {
        const T q = static_cast< T >( x >> t );
        if ( q )
        {
            x = q;
            r += t;
        }
        t /= 2;
    }

    return r;
}

} // namespace detail
} // namespace math
} // namespace zi

#endif


