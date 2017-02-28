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

#ifndef ZI_CONCURRENCY_PTHREAD_CONDITION_VARIABLE_HPP
#define ZI_CONCURRENCY_PTHREAD_CONDITION_VARIABLE_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/detail/is_mutex.hpp>
#include <zi/concurrency/pthread/spinlock.hpp>
#include <zi/concurrency/pthread/mutex_types.hpp>

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/enable_if.hpp>
#include <zi/utility/assert.hpp>

#include <zi/time/now.hpp>
#include <zi/time/interval.hpp>

#include <zi/meta/enable_if.hpp>

#include <pthread.h>


namespace zi {
namespace concurrency_ {


class condition_variable: non_copyable
{
private:
    struct  cv_tag;
    mutable pthread_cond_t cv_;

public:
    condition_variable()
    {
        ZI_VERIFY_0( pthread_cond_init( &cv_, NULL ) );
    }

    ~condition_variable()
    {
        ZI_VERIFY_0( pthread_cond_destroy( &cv_ ) );
    }

    template< class MutexTag >
    void wait( const mutex_tpl< MutexTag > &mutex ) const
    {
        ZI_VERIFY_0( pthread_cond_wait( &cv_, &mutex.mutex_ ) );
    }

    template< class Mutex >
    void wait( const mutex_guard< Mutex > &g ) const
    {
        ZI_VERIFY_0( pthread_cond_wait( &cv_, &g.m_.mutex_ ) );
    }

    template< class MutexTag >
    bool timed_wait( const mutex_tpl< MutexTag > &mutex, int64_t ttl ) const
    {
        timespec ts;
        time_utils::msec_to_ts( ts, now::msec() + ttl );
        return pthread_cond_timedwait( &cv_, &mutex.mutex_, &ts ) == 0;
    }

    template< class Mutex >
    bool timed_wait( const mutex_guard< Mutex > &g, int64_t ttl ) const
    {
        timespec ts;
        time_utils::msec_to_ts( ts, now::msec() + ttl );
        return pthread_cond_timedwait( &cv_, &g.m_.mutex_, &ts ) == 0;
    }

    template< class MutexTag, class T >
    bool timed_wait( const mutex_tpl< MutexTag > &mutex,
                     const T &ttl,
                     typename meta::enable_if< is_time_interval< T > >::type* = 0 )
        const
    {
        timespec ts;
        time_utils::nsec_to_ts( ts, now::nsec() + ttl.nsecs() );
        return pthread_cond_timedwait( &cv_, &mutex.mutex_, &ts ) == 0;
    }

    template< class Mutex, class T >
    bool timed_wait( const mutex_guard< Mutex > &g,
                     const T &ttl,
                     typename meta::enable_if< is_time_interval< T > >::type* = 0 )
        const
    {
        timespec ts;
        time_utils::nsec_to_ts( ts, now::nsec() + ttl.nsecs() );
        return pthread_cond_timedwait( &cv_, &g.m_.mutex_, &ts ) == 0;
    }

    void notify_one() const
    {
        ZI_VERIFY_0( pthread_cond_signal( &cv_ ) );
    }

    void notify_all() const
    {
        ZI_VERIFY_0( pthread_cond_broadcast( &cv_ ) );
    }
};


} // namespace concurrency_
} // namespace zi


#endif
