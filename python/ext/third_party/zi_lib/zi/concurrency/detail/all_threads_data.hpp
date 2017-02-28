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

#ifndef ZI_CONCURRENCY_DETAIL_ALL_THREADS_DATA_HPP
#define ZI_CONCURRENCY_DETAIL_ALL_THREADS_DATA_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/mutex.hpp>
#include <zi/concurrency/condition_variable.hpp>
#include <zi/concurrency/detail/thread_info.hpp>

#include <zi/utility/assert.hpp>

#include <zi/bits/unordered_map.hpp>
#include <zi/bits/shared_ptr.hpp>
#include <zi/bits/cstdint.hpp>

#include <cstddef>

#ifdef ZI_DEBUG_THREADS
#  include <iostream>
#endif


namespace zi {
namespace concurrency_ {
namespace detail {


template< class Id, class Handle >
struct all_threads_data
{
    std::size_t   pending_count_ ;
    std::size_t   running_count_ ;
    std::size_t   finished_count_;

    mutex              mutex_    ;
    condition_variable dying_cv_ ;
    bool               dying_    ;

    typedef thread_info< Id, Handle > info_t;
    typedef unordered_map< Id, shared_ptr< info_t > > thread_map;

    thread_map threads_  ;

    all_threads_data():
        running_count_( 0 ),
        finished_count_( 0 ),
        mutex_(),
        dying_cv_(),
        dying_( false )
    {
    }

    ~all_threads_data()
    {
        join_all();
        ZI_ASSERT_0( running_count_  );
        ZI_ASSERT_0( threads_.size() );
    }

    void join_all()
    {

#ifdef ZI_DEBUG_THREADS
        std::clog << " DYING... \n";
#endif
        mutex::guard g( mutex_ );

        dying_ = true;

        while ( running_count_ > 0 || pending_count_ > 0 )
        {
            dying_cv_.wait( g );
        }
#ifdef ZI_DEBUG_THREADS
        std::clog << " DYING DONE... \n";
#endif
    }

    void register_pending()
    {
        mutex::guard g( mutex_ );
        ++pending_count_;
    }

    void register_started( shared_ptr< info_t > t )
    {
        mutex::guard g( mutex_ );

#ifdef ZI_DEBUG_THREADS0
        std::clog << "Thread: " << t->get_id() << " started\n";
#endif

        threads_[ t->get_id() ] = t;
        ++running_count_;
        --pending_count_;
    }

    void register_finished( shared_ptr< info_t > t )
    {
        mutex::guard g( mutex_ );

#ifdef ZI_DEBUG_THREADS0

        std::clog << "Thread: " << t->get_id()
                  << " finished RUNTIME: "
                  << ((double)now::msec() - (double)t->start_time() ) / 1000 << " :: "
                  << (threads_.size() - 1) << " threads left\n"
                  << std::flush;

#endif

        ZI_VERIFY( threads_.erase( t->get_id() ) == 1 );

        --running_count_;
        ++finished_count_;

        if ( dying_ && running_count_ == 0 )
        {
            dying_cv_.notify_all();
        }
    }

    std::size_t finished_count() const
    {
        mutex::guard g( mutex_ );
        return finished_count_;
    }

    std::size_t started_count() const
    {
        mutex::guard g( mutex_ );
        return finished_count_ + running_count_;
    }

    std::size_t active_count() const
    {
        mutex::guard g( mutex_ );
        return running_count_;
    }

    shared_ptr< info_t > get_thread( const Id &t )
    {
        typename thread_map::iterator it = threads_.find( t );

        if ( it != threads_.end() )
        {
            return it->second;
        }
        else
        {
            return shared_ptr< info_t >();
        }
    }

};


} // namespace detail
} // namespace concurrency_
} // namespace zi

#endif

