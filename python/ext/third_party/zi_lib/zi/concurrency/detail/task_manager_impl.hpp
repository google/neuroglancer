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

#ifndef ZI_CONCURRENCY_DETAIL_TASK_MANAGER_IMPL_HPP
#define ZI_CONCURRENCY_DETAIL_TASK_MANAGER_IMPL_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/thread.hpp>
#include <zi/concurrency/mutex.hpp>
#include <zi/concurrency/condition_variable.hpp>
#include <zi/concurrency/runnable.hpp>

#include <zi/bits/enable_shared_from_this.hpp>
#include <zi/bits/shared_ptr.hpp>
#include <zi/utility/assert.hpp>

#include <cstddef>
#include <algorithm>
#include <limits>

namespace zi {
namespace concurrency_ {

template< class TaskContainer >
struct task_manager_impl
    : runnable,
      enable_shared_from_this< task_manager_impl< TaskContainer > >
{

    enum state
    {
        IDLE = 0,
        STARTING,
        RUNNING,
        STOPPING
    };

    std::size_t worker_count_;
    std::size_t worker_limit_;
    std::size_t idle_workers_;
    std::size_t active_workers_;
    std::size_t max_size_;

    state state_;

    mutex mutex_;
    condition_variable workers_cv_;
    condition_variable manager_cv_;

    TaskContainer tasks_;

    task_manager_impl( std::size_t worker_limit, std::size_t max_size ) :
        worker_count_( 0 ),
        worker_limit_( worker_limit ),
        idle_workers_( 0 ),
        active_workers_( 0 ),
        max_size_( max_size ),
        state_( IDLE ),
        mutex_(),
        workers_cv_(),
        manager_cv_(),
        tasks_()
    {
    }

    ~task_manager_impl()
    {
        stop();
    }

    std::size_t size()
    {
        mutex::guard g( mutex_ );
        return tasks_.size();
    }

    std::size_t empty()
    {
        mutex::guard g( mutex_ );
        return tasks_.empty();
    }

    std::size_t worker_count()
    {
        mutex::guard g( mutex_ );
        return worker_count_;
    }

    std::size_t worker_limit()
    {
        mutex::guard g( mutex_ );
        return worker_limit_;
    }

    std::size_t idle_workers()
    {
        mutex::guard g( mutex_ );
        return idle_workers_;
    }


    void create_workers_nl( std::size_t count )
    {

        if ( count <= 0 || active_workers_ >= worker_limit_ )
        {
            return;
        }

        for ( ; count && active_workers_ <= worker_limit_; --count, ++active_workers_ )
        {
            thread t( this->shared_from_this() );
            t.start();
        }

        manager_cv_.wait( mutex_ );
    }

    void kill_workers_nl( std::size_t count )
    {
        if ( count <= 0 || active_workers_ <= 0 )
        {
            return;
        }

        active_workers_ = ( count > active_workers_ ) ? 0 : active_workers_ - count;

        workers_cv_.notify_all();

        while ( worker_count_ != active_workers_ )
        {
            manager_cv_.wait( mutex_ );
        }
    }

    void add_workers( std::size_t count )
    {
        mutex::guard g( mutex_ );

        if ( count <= 0 )
        {
            return;
        }

        worker_limit_ += count;

        if ( state_ == IDLE || state_ == STOPPING )
        {
            return;
        }

        create_workers_nl( count );
    }

    void remove_workers( std::size_t count )
    {
        mutex::guard g( mutex_ );

        if ( count <= 0 || worker_limit_ <= 0 )
        {
            return;
        }

        count = ( count > worker_limit_ ) ? worker_limit_ : count;

        worker_limit_ -= count;

        if ( state_ == IDLE || state_ == STOPPING )
        {
            return;
        }

        kill_workers_nl( count );
    }


    bool start()
    {

        mutex::guard g( mutex_ );

        if ( state_ != IDLE )
        {
            return false;
        }

        ZI_ASSERT_0( worker_count_ );
        ZI_ASSERT_0( idle_workers_ );

        state_ = STARTING;

        create_workers_nl( worker_limit_ );

        state_ = RUNNING;
        // workers_cv_.notify_all(); todo: pause?

        return true;
    }

    void stop( bool and_join = false )
    {
        mutex::guard g( mutex_ );

        if ( state_ != RUNNING )
        {
            return;
        }

        state_ = STOPPING;

        if ( !and_join )
        {
            tasks_.clear();
        }

        kill_workers_nl( active_workers_ );
        state_ = IDLE;
    }

    void join()
    {
        stop( true );
    }

    void push_front( shared_ptr< runnable > task )
    {
        mutex::guard g( mutex_ );

        tasks_.push_front( task );

        if ( state_ == RUNNING && idle_workers_ > 0 )
        {
            workers_cv_.notify_all();
        }
    }

    void push_back( shared_ptr< runnable > task )
    {
        mutex::guard g( mutex_ );

        tasks_.push_back( task );

        if ( state_ == RUNNING && idle_workers_ > 0 )
        {
            workers_cv_.notify_all();
        }
    }

    template< class Tag >
    void push_front( shared_ptr< runnable > task )
    {
        mutex::guard g( mutex_ );

        tasks_.template push_front< Tag >( task );

        if ( state_ == RUNNING && idle_workers_ > 0 )
        {
            workers_cv_.notify_all();
        }
    }

    template< class Tag >
    void push_back( shared_ptr< runnable > task )
    {
        mutex::guard g( mutex_ );

        tasks_.template push_back< Tag >( task );

        if ( state_ == RUNNING && idle_workers_ > 0 )
        {
            workers_cv_.notify_all();
        }
    }

    void clear()
    {
        mutex::guard g( mutex_ );
        tasks_.clear();
    }

    void run()
    {

        {
            mutex::guard g( mutex_ );
            ++worker_count_;

            if ( worker_count_ == active_workers_ )
            {
                manager_cv_.notify_one();
            }
        }

        shared_ptr< runnable > task;

        for ( bool active = true; active; )
        {
            {
                mutex::guard g( mutex_ );

                while ( worker_count_ <= active_workers_ && tasks_.empty() )
                {
                    ++idle_workers_;
                    workers_cv_.wait( g );
                    --idle_workers_;
                }

                if ( worker_count_ <= active_workers_ ||
                     ( state_ == STOPPING && tasks_.size() ) )
                {
                    if ( tasks_.size() )
                    {
                        task = tasks_.front();
                        tasks_.pop_front();
                    }
                }
                else
                {
                    --worker_count_;
                    if ( worker_count_ == active_workers_ )
                    {
                        manager_cv_.notify_one();
                    }
                    return;
                }
            }

            if ( task )
            {
                task->execute();
                task.reset();
            }
        }
    }

};

} // namespace concurrency_
} // namespace zi

#endif

