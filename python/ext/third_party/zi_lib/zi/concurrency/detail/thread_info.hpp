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

#ifndef ZI_CONCURRENCY_DETAIL_THREAD_INFO_HPP
#define ZI_CONCURRENCY_DETAIL_THREAD_INFO_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/mutex.hpp>
#include <zi/concurrency/condition_variable.hpp>
#include <zi/concurrency/runnable.hpp>

#include <zi/bits/shared_ptr.hpp>
#include <zi/bits/enable_shared_from_this.hpp>
#include <zi/bits/cstdint.hpp>

#include <zi/utility/assert.hpp>
#include <zi/time/interval.hpp>
#include <zi/time/now.hpp>

#ifdef ZI_DEBUG_THREADS
#  include <iostream>
#endif


namespace zi {
namespace concurrency_ {
namespace detail {

template< class Id, class Handle >
struct thread_info: enable_shared_from_this< thread_info< Id, Handle > >
{
public:
    typedef thread_info< Id, Handle > this_type      ;
    typedef Id                        thread_id_t    ;
    typedef Handle                    thread_handle_t;

protected:

    enum state
    {
        CREATED     = 0,
        INITIALIZED    ,
        STARTING       ,
        RUNNING        ,
        SLEEPING       ,
        JOINING        ,
        JOINED
    };

    state state_;
    bool  detached_;
    mutex mutex_;
    condition_variable join_cv_;
    condition_variable state_cv_;
    condition_variable sleep_cv_;

    int64_t creation_time_;
    int64_t start_time_   ;

    shared_ptr< runnable  > runnable_;
    shared_ptr< this_type > self_    ;
    Handle                  handle_  ;
    Id                      id_      ;
    Id                      parent_  ;

    void lock_ptr_()
    {
        ZI_ASSERT( !self_ );
        self_ = this->shared_from_this();
    }

    void unlock_ptr_()
    {
        ZI_ASSERT( self_.get() == this );
        self_.reset();
    }

public:

    thread_info( shared_ptr< runnable > run ):
        state_( CREATED ),
        detached_( false ),
        mutex_(),
        join_cv_(),
        state_cv_(),
        sleep_cv_(),
        creation_time_( now::msec() ),
        start_time_( 0 ),
        runnable_( run ),
        self_(),
        handle_(),
        id_(),
        parent_(0)
    {
    }

    bool initialize( Id parent_id, bool detached = true )
    {
        mutex::guard g( mutex_ );

        if ( state_ != CREATED )
        {
            return false;
        }

        lock_ptr_();
        parent_   = parent_id;
        detached_ = detached ;

        state_ = INITIALIZED;

        return true;
    }

    bool on_before_start( const Id &id, const Handle &handle )
    {
        mutex::guard g( mutex_ );

        if ( state_ != INITIALIZED )
        {
            return false;
        }

        id_     = id;
        handle_ = handle;

        ZI_ASSERT( id_                 );
        ZI_ASSERT( this == self_.get() );
        ZI_ASSERT( runnable_           );

        state_ = STARTING;

        return true;
    }

    bool run()
    {
        {
            mutex::guard g( mutex_ );

            if ( state_ != STARTING )
            {
                return false;
            }

            state_ = RUNNING;
        }

        runnable_->execute();

        {
            mutex::guard g( mutex_ );

            if ( state_ != RUNNING )
            {
                return false;
            }

            state_ = JOINING;

        }

        return true;
    }

    bool on_before_join()
    {
        mutex::guard g( mutex_ );

        if ( state_ != JOINING )
        {
            return false;
        }

        state_ = JOINED;

        state_cv_.notify_all();

        unlock_ptr_();

        return true;
    }

    void detach() throw()
    {
        mutex::guard g( mutex_ );
        detached_ = true;
        state_cv_.notify_all();
    }

    shared_ptr< this_type > get_ptr()
    {
        mutex::guard g( mutex_ );
        ZI_ASSERT( self_.get() == this );
        return self_;
    }

    bool sleep( int64_t msec )
    {
        mutex::guard g( mutex_ );
        if ( state_ == RUNNING )
        {
            state_ = SLEEPING;
            bool awaken = sleep_cv_.timed_wait( mutex_, msec );
            if ( state_ == SLEEPING )
            {
                state_ = RUNNING;
            }

            return !awaken;
        }

        return false;
    }

    template< int64_t I >
    bool sleep( const interval::detail::interval_tpl< I > &i )
    {
        mutex::guard g( mutex_ );
        if ( state_ == RUNNING )
        {
            state_ = SLEEPING;
            bool awaken = sleep_cv_.timed_wait( mutex_, i );
            if ( state_ == SLEEPING )
            {
                state_ = RUNNING;
            }

            return !awaken;
        }

        return false;
    }

    bool usleep( int64_t usec )
    {
        mutex::guard g( mutex_ );
        if ( state_ == RUNNING )
        {

#ifdef ZI_DEBUG_THREADS
            std::cout << "Thread: " << handle_ << " going to sleep\n";
#endif

            state_ = SLEEPING;
            bool awaken = sleep_cv_.timed_wait( mutex_, interval::usecs( usec ) );
            if ( state_ == SLEEPING )
            {
                state_ = RUNNING;
            }

#ifdef ZI_DEBUG_THREADS
            std::cout << "Thread: " << handle_ << " woke up " << awaken << "\n";
#endif

            return !awaken;
        }

        return false;
    }

    bool join()
    {
        mutex::guard g( mutex_ );

        if ( detached_ )
        {
            return false;
        }

        while ( state_ != JOINED )
        {
            if ( detached_ )
            {
                return false;
            }
            state_cv_.wait( g );
        }

        return true;
    }

    void wake()
    {
        mutex::guard g( mutex_ );
        if ( state_ == SLEEPING )
        {
            sleep_cv_.notify_one();
        }
    }

    Id get_id()
    {
        return id_;
    }

    int64_t creation_time() const
    {
        return creation_time_;
    }

    int64_t start_time() const
    {
        return start_time_;
    }


};


} // namespace detail
} // namespace concurrency_
} // namespace zi

#endif
