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

#ifndef ZI_CONCURRENCY_WIN32_DETAIL_INTERLOCKED_HPP
#define ZI_CONCURRENCY_WIN32_DETAIL_INTERLOCKED_HPP 1

#include <zi/concurrency/config.hpp>

namespace zi {
namespace concurrency_ {
namespace win32 {

#if 0

#ifdef ZI_CXX_MSVC

extern "C" void _ReadWriteBarrier( void );
#pragma intrinsic( _ReadWriteBarrier )

inline long interlocked_read_acquire( volatile long* x )
{
    const long value = *x;
    _ReadWriteBarrier( );
    return value;
}

inline void* interlocked_read_acquire( volatile void** x )
{
    const void* value = *x;
    _ReadWriteBarrier( );
    return value;
}

inline void interlocked_write_release( volatile long* x, long value )
{
    _ReadWriteBarrier( );
    *x = value;
}

inline void interlocked_write_release( volatile void** x, void* value )
{
    _ReadWriteBarrier( );
    *x = value;
}

#else

inline long interlocked_read_acquire( long* x )
{
    return InterlockedCompareExchange( x, 0, 0 );
}

inline void* interlocked_read_acquire( void** x )
{
    return InterlockedCompareExchangePointer( x, 0, 0 );
}

inline void interlocked_write_release( long* x, long value )
{
    (void) InterlockedExchange( x, value );
}

inline void interlocked_write_release( void** x, void* value )
{
    (void) InterlockedExchangePointer( x, value );
}

#endif

using ::zi::atomic::atomic_word;
using ::zi::atomic::compare_swap;
using ::zi::atomic::add_swap;
using ::zi::atomic::increment;
using ::zi::atomic::decrement;
using ::zi::atomic::increment_swap;
using ::zi::atomic::decrement_swap;
using ::zi::atomic::write;
using ::zi::atomic::read;
using ::zi::atomic::test_increment_swap;


#endif // 0

using ::InterlockedIncrement;
using ::InterlockedDecrement;
using ::InterlockedCompareExchange;
using ::InterlockedExchange;
using ::InterlockedExchangeAdd;

} // namespace win32
} // namespace concurrency_
} // namespace zi

#endif
