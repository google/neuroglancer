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

#ifndef ZI_MATH_INTEGRAL_LOG2_HPP
#define ZI_MATH_INTEGRAL_LOG2_HPP 1

#include <zi/bits/cstdint.hpp>

namespace zi {
namespace math {

namespace int_log2_ {

inline uint64_t step_a( uint64_t x )
{
    uint64_t c1 = 0x8080808080808080ull;
    return ( x | ( ~( ~( x | c1 ) + 0x0101010101010101ull ) )) & c1;
}

inline uint64_t step_ab( uint64_t x )
{
    return (( ( step_a( x ) >> 7 ) * 0x8040201008040201ull ) >> 56 );
}

inline uint64_t step_abc( uint64_t x )
{
    uint64_t b = step_ab( x );
    return ( b & -b );
}

inline uint64_t step_abcd( uint64_t x )
{
    uint64_t p = (( step_abc( x ) * 0x8040201008040201ull ) &
                  0x8080808080808080ull );
    uint64_t q = p - 1;
    q = ( p | q ) ^ ( q >> 7 );
    uint64_t r = ( ( q & x ) * 0x0101010101010101ull );
    r >>= 56;
    r *= 0x8040201008040201ull;
    r &= 0x8080808080808080ull;
    r &= -r;
    r >>= 7;
    r *= 0x8040201008040201ull;
    return ( p >> 7 ) * ( r >> 56 );
}

inline uint64_t int_log2( uint64_t x )
{
    return step_abcd( x );
}

inline uint64_t bit_position( uint64_t y )
{
    uint64_t z = ( y - 1 ) & 0x8080808080808080ull;
    z *= 0x0202020202020202ull;
    z >>= 53;
    uint64_t p = ( y >> z );
    p *= 0x8040201008040201ull;
    p &= 0x8080808080808080ull;
    p *= 0x120e0c0a08060402ull;
    return ( p >> 56 ) + z;
}


}

using int_log2_::bit_position;
using int_log2_::int_log2;


} // namespace math
} // namespace zi

#endif
