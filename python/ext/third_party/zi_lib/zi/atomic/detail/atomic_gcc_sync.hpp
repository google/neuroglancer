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

#ifndef ZI_ATOMIC_DETAIL_ATOMIC_GCC_SYNC_HPP
#define ZI_ATOMIC_DETAIL_ATOMIC_GCC_SYNC_HPP 1

#ifndef ZI_ATOMIC_ATOMIC_HPP_INCLUDING
#  error "don't include this file directly, use atomic.hpp"
#endif

typedef int atomic_word;

inline atomic_word compare_swap( volatile atomic_word *ptr, atomic_word val, atomic_word cmp )
{
    return ::__sync_val_compare_and_swap( const_cast< atomic_word* >( ptr ), cmp, val );
}

inline atomic_word add_swap( volatile atomic_word *ptr, atomic_word val )
{
    return ::__sync_fetch_and_add( const_cast< atomic_word* >( ptr ), val );
}

inline void increment( volatile atomic_word *ptr )
{
    (void )add_swap( ptr, 1 );
}

inline void decrement( volatile atomic_word *ptr )
{
    (void )add_swap( ptr, uint32_t( -1 ) );
}

inline atomic_word increment_swap( volatile atomic_word *ptr )
{
    return add_swap( ptr, 1 );
}

inline atomic_word decrement_swap( volatile atomic_word *ptr )
{
    return add_swap( ptr, uint32_t( -1 ) );
}

inline void write( volatile atomic_word *ptr, atomic_word val )
{
    *ptr = val;
}

inline atomic_word read( volatile atomic_word *ptr )
{
    return *ptr;
}

inline atomic_word test_increment_swap( volatile atomic_word *ptr )
{
    atomic_word ret;

    do {
        ret = read( ptr );

        if (ret == 0 )
        {
            return ret;
        }

    } while ( !::__sync_bool_compare_and_swap( const_cast< atomic_word* >( ptr ), ret, ret + 1 ) );

    return ret;
}

#endif
