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

#ifndef ZI_ATOMIC_DETAIL_ATOMIC_GCC_I386_HPP
#define ZI_ATOMIC_DETAIL_ATOMIC_GCC_I386_HPP 1

#ifndef ZI_ATOMIC_ATOMIC_HPP_INCLUDING
#  error "don't include this file directly, use atomic.hpp"
#endif

typedef int32_t atomic_word;

inline atomic_word compare_swap( volatile atomic_word *ptr, atomic_word val, atomic_word cmp )
{
    atomic_word old = cmp;
    asm volatile ( "lock\n\t"
                   "cmpxchgl %3, %1":
                   "=a"(old), "=m"(*ptr):
                   "0" (old), "r" (val):
                   "memory", "cc"
        );
    return old;
}

inline atomic_word add_swap( volatile atomic_word *ptr, atomic_word val )
{
    atomic_word result;
    asm volatile( "lock\n\t"
                  "xaddl %1, %0":
                  "+m"(*ptr), "=r"(result):
                  "1"(val):
                  "memory", "cc"
        );

    return result;
}


inline void increment( volatile atomic_word *ptr )
{
    asm volatile ( "lock\n\t"
                   "incl %0":
                   "=m"(*ptr):
                   "m" (*ptr):
                   "cc"
        );
}

inline void decrement( volatile atomic_word *ptr )
{
    asm volatile ( "lock\n\t"
                   "decl %0":
                   "=m"(*ptr):
                   "m" (*ptr):
                   "cc"
        );
}

inline atomic_word increment_swap( volatile atomic_word *ptr )
{
    return add_swap( ptr, 1 );
}

inline atomic_word decrement_swap( volatile atomic_word *ptr )
{
    return add_swap( ptr, -1 );
}

inline atomic_word test_increment_swap( volatile atomic_word *ptr )
{
    atomic_word res, tmp;
    asm volatile ( "movl %0, %%eax\n\t"
                   "0:\n\t"
                   "test %%eax, %%eax\n\t"
                   "je 1f\n\t"
                   "movl %%eax, %2\n\t"
                   "incl %2\n\t"
                   "lock\n\t"
                   "cmpxchgl %2, %0\n\t"
                   "jne 0b\n\t"
                   "1:":
                   "=m"(*ptr), "=&a"(res), "=&r"(tmp):
                   "m" (*ptr):
                   "cc"
        );

    return res;
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
