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

#ifndef ZI_CONCURRENCY_WIN32_CONDITION_VARIABLE_HPP
#define ZI_CONCURRENCY_WIN32_CONDITION_VARIABLE_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/win32/mutex_types.hpp>
#include <zi/concurrency/win32/spinlock.hpp>
#include <zi/concurrency/win32/detail/primitives.hpp>
#include <zi/concurrency/win32/detail/interlocked.hpp>

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/assert.hpp>

#include <zi/meta/enable_if.hpp>

#include <zi/time/now.hpp>
#include <zi/time/interval.hpp>

namespace zi {
namespace concurrency_ {


class condition_variable: non_copyable
{
private:
    spinlock              spinlock_     ;
    win32::handle         semaphore_    ;
    win32::handle         last_event_   ;
    mutable bool          broadcasting_ ;
    mutable win32::dword  waiters_      ;

    template< class Mutex >
    bool wait_( const Mutex &mutex, win32::dword ttl = win32::forever ) const
    {
        {
            spinlock::guard g( spinlock_ );
            ++waiters_;
        }

        bool got_it = win32::SignalObjectAndWait( mutex.handle_, semaphore_, ttl, false ) == 0;

        bool last;

        {
            spinlock::guard g( spinlock_ );
            --waiters_;
            last = broadcasting_ && waiters_ == 0;
        }


        if ( last )
        {
            ZI_VERIFY_0( win32::SignalObjectAndWait( last_event_, mutex.handle_,
                                                     win32::forever, false ) );
        }
        else
        {
            ZI_VERIFY_0( win32::WaitForSingleObject( mutex.handle_, win32::forever ) );
        }

        return got_it;
    }


public:

    condition_variable():
        spinlock_(),
        semaphore_( win32::CreateSemaphore( NULL, 0, 0x7FFFFFFF, NULL ) ),
        last_event_( win32::CreateSemaphore( NULL, 0, 0x7FFFFFFF, NULL ) ),
        broadcasting_( false ),
        waiters_( 0 )
    {
        ZI_ASSERT( semaphore_  );
        ZI_ASSERT( last_event_ );
    }

    ~condition_variable()
    {
        ZI_VERIFY( win32::CloseHandle( semaphore_  ) );
        ZI_VERIFY( win32::CloseHandle( last_event_ ) );
    }

    template< class MutexTag >
    void wait( const mutex_tpl< MutexTag > &mutex ) const
    {
        (void) wait_( mutex );
    }

    template< class Mutex >
    void wait( const mutex_guard< Mutex > &g ) const
    {
        (void) wait_( g.m_ );
    }

    template< class MutexTag >
    bool timed_wait( const mutex_tpl< MutexTag > &mutex, int64_t ttl ) const
    {
        return wait_( mutex, static_cast< win32::dword >( ttl ) );
    }

    template< class Mutex >
    bool timed_wait( const mutex_guard< Mutex > &g, int64_t ttl ) const
    {
        return wait_( g.m_, static_cast< win32::dword >( ttl ) );
    }

    template< class MutexTag, class T >
    bool timed_wait( const mutex_tpl< MutexTag > &mutex,
                     const T &ttl,
                     typename meta::enable_if< is_time_interval< T > >::type* = 0 ) const
    {
        return wait_( mutex, static_cast< win32::dword >( ttl.msecs() ) );
    }

    template< class Mutex, class T >
    bool timed_wait( const mutex_guard< Mutex > &g,
                     const T &ttl,
                     typename meta::enable_if< is_time_interval< T > >::type* = 0 ) const
    {
        return wait_( g.m_, static_cast< win32::dword >( ttl.msecs() ) );
    }

    void notify_one() const
    {
        if ( waiters_ > 0 )
        {
            win32::ReleaseSemaphore( semaphore_, 1, 0 );
        }
    }

    void notify_all() const
    {
        spinlock_.lock();

        broadcasting_ = waiters_ > 0;

        if ( broadcasting_ )
        {
            ZI_VERIFY( win32::ReleaseSemaphore( semaphore_, waiters_, 0 ) );
            spinlock_.unlock();
            ZI_VERIFY_0( win32::WaitForSingleObject( last_event_, win32::forever ) );
            broadcasting_ = 0;
        }
        else
        {
            spinlock_.unlock();
        }
    }
};


} // namespace concurrency_
} // namespace zi

#endif
