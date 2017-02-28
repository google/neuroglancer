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

#ifndef ZI_ATOMIC_DETAIL_ATOMIC_GCC_PPC_HPP
#define ZI_ATOMIC_DETAIL_ATOMIC_GCC_PPC_HPP 1

#ifndef ZI_ATOMIC_ATOMIC_HPP_INCLUDING
#  error "don't include this file directly, use atomic.hpp"
#endif

typedef int32_t atomic_word;

inline atomic_word compare_swap( volatile atomic_word *ptr, atomic_word val, atomic_word cmp )
{
    atomic_word old = cmp;

    asm volatile ( "0:\n\t"
                   "lwarx  %0,0,%1\n\t"
                   "cmpw   %0,%3\n\t"
                   "bne-   1f\n\t"
                   "stwcx. %2,0,%1\n\t"
                   "bne-   0b\n\t"
                   "1:"
                   : "=&r"(old)
                   : "b" (ptr), "r" (val), "r"(cmp)
                   : "memory", "cc");

    return old;
}

inline atomic_word add_swap( volatile atomic_word *ptr, atomic_word val )
{
    atomic_word result, temp;

    asm volatile ( "0:\n\t"
                   "lwarx  %0,0,%2\n\t"
                   "add    %1,%0,%3\n\t"
                   "stwcx. %1,0,%2\n\t"
                   : "=&r" (result), "=&r" (temp)
                   : "b" (ptr), "r" (val)
                   : "memory", "cc");

    (void)temp;
    return result;
}


inline void increment( volatile atomic_word *ptr )
{
    (void)add_swap( ptr, atomic_word( 1 ) );
}

inline void decrement( volatile atomic_word *ptr )
{
    (void)add_swap( ptr, atomic_word( -1 ) );
}

inline atomic_word increment_swap( volatile atomic_word *ptr )
{
    return add_swap( ptr, atomic_word( 1 ) );
}

inline atomic_word decrement_swap( volatile atomic_word *ptr )
{
    return add_swap( ptr, atomic_word( -1 ) );
}

inline atomic_word test_increment_swap( volatile atomic_word *ptr )
{
    // TODO: Implement!
    return 0;
}

inline void write( volatile atomic_word *ptr, atomic_word val )
{
    *ptr = val;
}

inline atomic_word read( volatile atomic_word *ptr )
{
    return *ptr;
}

#endif
