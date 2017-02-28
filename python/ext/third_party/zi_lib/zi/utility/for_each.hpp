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

#ifndef ZI_UTILITY_FOR_EACH_HPP
#define ZI_UTILITY_FOR_EACH_HPP 1

#include <zi/bits/typeof.hpp>

#if defined ( __typeof__ )

#  define FOR_EACH( it, cnt )                                   \
    FOR_EACH_RANGE( it, ( cnt ).begin(), ( cnt ).end() )

#  define FOR_EACH_R( it, cnt )                                 \
    FOR_EACH_RANGE( it, ( cnt ).rbegin(), ( cnt ).rend() )

#  define REVERSE_FOR_EACH FOR_EACH_R

#  define FOR_EACH_RANGE( it, begin, end )                              \
    for (__typeof__( begin ) it = ( begin ); it != ( end ); ++it)

#  define FOR_EACH_ERASE_RANGE( it, begin, end, cnt )                   \
    for (__typeof__( begin ) it = ( begin ); it != ( end ); it = ( cnt ).erase( it ) )

#  define FOR_EACH_ERASE( it, cnt )                                     \
    FOR_EACH_ERASE_RANGE( it, ( cnt ).begin(), ( cnt ).end(), cnt )

#  define FOR_EACH_R_ERASE( it, cnt )                                   \
    FOR_EACH_ERASE_RANGE( it, ( cnt ).rbegin(), ( cnt ).rend(), cnt )

#  define REVERSE_FOR_EACH_ERASE FOR_EACH_R_ERASE


#  ifdef ZI_USE_LOWERCASE_FOREACH
#
#    ifndef foreach
#      define foreach FOR_EACH
#    endif
#
#    ifndef foreach_r
#      define foreach_r FOR_EACH_R
#    endif
#
#    ifndef reverse_foreach
#      define reverse_foreach foreach_r
#    endif
#
#    ifndef foreach_range
#      define foreach_range FOR_EACH_RANGE
#    endif
#
#  endif // ZI_NO_LOWERCASE_FOREACH

#else  // defined( __typeof__ ) not defined
#  error "can't define FOR_EACH macros with no __typeof__ defined"

#endif // defined( __typeof__ )

#endif
