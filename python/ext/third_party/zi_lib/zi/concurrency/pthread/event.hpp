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

#ifndef ZI_CONCURRENCY_PTHREAD_EVENT_HPP
#define ZI_CONCURRENCY_PTHREAD_EVENT_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/pthread/mutex_types.hpp>

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/assert.hpp>

#include <pthread.h>


namespace zi {
namespace concurrency_ {


class event: non_copyable
{
private:
    mutable bool           signalled_ ;
    mutable pthread_cond_t cv_        ;

public:
    event(): signalled_( false )
    {
        ZI_VERIFY_0( pthread_cond_init( &cv_, NULL ) );
    }

    ~event()
    {
        ZI_VERIFY_0( pthread_cond_destroy( &cv_ ) );
    }

    template< class MutexTag >
    void wait( const mutex_tpl< MutexTag > &mutex ) const
    {
        while ( !signalled_ )
        {
            ZI_VERIFY_0( pthread_cond_wait( &cv_, &mutex.mutex_ ) );
        }
    }

    template< class Mutex >
    void wait( const mutex_guard< Mutex > &g ) const
    {
        while ( !signalled_ )
        {
            ZI_VERIFY_0( pthread_cond_wait( &cv_, &g.m_.mutex_ ) );
        }
    }

    void signal() const
    {
        signalled_ = true;
        ZI_VERIFY_0( pthread_cond_signal( &cv_ ) );
    }

    void clear() const
    {
        signalled_ = false;
    }
};


} // namespace concurrency_
} // namespace zi


#endif
