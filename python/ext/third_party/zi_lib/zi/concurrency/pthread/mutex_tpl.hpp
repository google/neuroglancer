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

#ifndef ZI_CONCURRENCY_PTHREAD_MUTEX_TPL_HPP
#define ZI_CONCURRENCY_PTHREAD_MUTEX_TPL_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/detail/mutex_guard.hpp>
#include <zi/concurrency/detail/mutex_pool.hpp>
#include <zi/concurrency/pthread/mutex_tags.hpp>
#include <zi/concurrency/pthread/mutex_initializers.hpp>

#include <zi/utility/assert.hpp>
#include <zi/utility/non_copyable.hpp>

#include <cstring>
#include <errno.h>
#include <pthread.h>
#include <iostream>

namespace zi {
namespace concurrency_ {

// forward declarations
class condition_variable;
class event;

template< class PtMutexTag > class mutex_tpl: non_copyable
{
private:

    mutable pthread_mutex_t mutex_;
    friend class condition_variable;
    friend class event;

public:

    mutex_tpl()
    {
        mutex_initializer< PtMutexTag >::initialize( mutex_ );
    }

    ~mutex_tpl()
    {
        const int code = pthread_mutex_destroy( &mutex_ );

#ifndef ZI_OS_MACOS

        if(!code){
            return;
        } else if(code == EBUSY) {
            std::cerr << "mutex already locked\n";
        } else if( code == EINVAL ){
            std::cerr << "value specified by mutex is invalid\n";
        }

        // http://stackoverflow.com/questions/7901117/how-do-i-use-errno-in-c
        if(!errno)
        {
            char buffer[ 256 ];
            char* errorMessage = strerror_r( errno, buffer, 256 ); // get string message from errno
            std::cerr << "mutex_tpl: destructor: pthread_mutex_destroy error: \n\t"
                      << errorMessage << std::endl;
        }

#else
        ZI_VERIFY_0(code);
#endif
    }

    inline bool try_lock() const
    {
        return ( pthread_mutex_trylock( &mutex_ ) == 0 );
    }

    inline void lock() const
    {
        ZI_VERIFY_0( pthread_mutex_lock( &mutex_ ) );
    }

    inline void unlock() const
    {
        ZI_VERIFY_0( pthread_mutex_unlock( &mutex_ ) );
    }

    typedef mutex_guard< mutex_tpl< PtMutexTag > > guard;

    template< class Tag >
    struct pool: mutex_pool< Tag, mutex_tpl< PtMutexTag > > { };

};

} // namespace concurrency_
} // namespace zi

#endif
