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

#ifndef ZI_CONCURRENCY_WIN32_SPINLOCK_FAST_HPP
#define ZI_CONCURRENCY_WIN32_SPINLOCK_FAST_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/detail/mutex_guard.hpp>
#include <zi/concurrency/detail/mutex_pool.hpp>
#include <zi/concurrency/detail/compiler_fence.hpp>
#include <zi/concurrency/win32/detail/primitives.hpp>
#include <zi/concurrency/win32/detail/interlocked.hpp>

#include <zi/utility/non_copyable.hpp>

// silly int->bool warning in msvc
#if defined( ZI_CXX_MSVC )
#  pragma warning( push )
#  pragma warning( disable: 4800 )
#endif

#if defined( _MSC_VER ) && _MSC_VER >= 1310 && ( defined( _M_X64 ) )

extern "C" void _mm_pause();

#pragma intrinsic( _mm_pause )
#
#define ZI_CONCURRENCY_SMT_PAUSE _mm_pause()
#
#elif defined( __GNUC__ ) && ( defined( __i386__ ) || defined( __x86_64__ ) )
#
#define ZI_CONCURRENCY_SMT_PAUSE asm volatile( "rep; nop" : : : "memory" )
#
#endif


namespace zi {
namespace concurrency_ {


class spinlock: non_copyable
{
private:
    mutable long lock_;

public:

    spinlock(): lock_( 0 )
    {
    }

    ~spinlock()
    {
        ZI_ASSERT_0( lock_ );
    }

    inline bool try_lock() const
    {
        long r = win32::InterlockedExchange( &lock_, 1 );

        ZI_CONCURRENCY_COMPILER_FENCE

        return r == 0;
    }

    inline void lock() const
    {
        for ( unsigned i = 0; !try_lock(); ++i )
        {
            if ( i < 4 )
            {

            }
#if defined( ZI_CONCURRENCY_SMT_PAUSE )
            else if ( i < 16 )
            {
                ZI_CONCURRENCY_SMT_PAUSE;
            }
#endif
            else if ( i < 32 )
            {
                win32::Sleep( 0 );
            }
            else
            {
                win32::Sleep( 1 );
            }
        }
    }

    inline void unlock() const
    {
        ZI_CONCURRENCY_COMPILER_FENCE

        *const_cast< long volatile* >( &lock_ ) = 0;
    }

    typedef mutex_guard< spinlock > guard;

    template< class Tag >
    struct pool: mutex_pool< Tag, spinlock > { };

};


} // namespace concurrency_
} // namespace zi

#if defined( ZI_CXX_MSVC )
#  pragma warning( pop )
#endif

#endif
