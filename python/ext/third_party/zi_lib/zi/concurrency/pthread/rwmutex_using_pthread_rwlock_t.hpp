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

#ifndef ZI_CONCURRENCY_PTHREAD_RWMUTEX_USING_PTHREAD_RWLOCK_T_HPP
#define ZI_CONCURRENCY_PTHREAD_RWMUTEX_USING_PTHREAD_RWLOCK_T_HPP 1

#include <zi/concurrency/config.hpp>

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/assert.hpp>

#include <pthread.h>

namespace zi {
namespace concurrency_ {

class rwmutex: non_copyable
{
private:

    mutable pthread_rwlock_t m_;

public:

    rwmutex()
    {
        static const pthread_rwlock_t stored_initializer =
            PTHREAD_RWLOCK_WRITER_NONRECURSIVE_INITIALIZER_NP;
        m_ = stored_initializer;
    }

    ~rwmutex()
    {
        ZI_VERIFY_0( pthread_rwlock_destroy( &m_ ) );
    }

    inline bool try_acquire_read() const
    {
        return ( 0 == pthread_rwlock_tryrdlock( &m_ ) );
    }

    inline bool try_acquire_write() const
    {
        return ( 0 == pthread_rwlock_trywrlock( &m_ ) );
    }

    inline void acquire_read() const
    {
        ZI_VERIFY_0( pthread_rwlock_rdlock( &m_ ) );
    }

    inline void acquire_write() const
    {
        ZI_VERIFY_0( pthread_rwlock_wrlock( &m_ ) );
    }

    inline void release() const
    {
        ZI_VERIFY_0( pthread_rwlock_unlock( &m_ ) );
    }

    inline void release_read() const
    {
        ZI_VERIFY_0( pthread_rwlock_unlock( &m_ ) );
    }

    inline void release_write() const
    {
        ZI_VERIFY_0( pthread_rwlock_unlock( &m_ ) );
    }

    class read_guard
    {
    private:
        const rwmutex &m_;

    public:
        explicit read_guard( const rwmutex &m ): m_( m )
        {
            m_.acquire_read();
        }

        ~read_guard()
        {
            m_.release_read();
        }
    };

    class write_guard
    {
    private:
        const rwmutex &m_;

    public:
        explicit write_guard( const rwmutex &m ): m_( m )
        {
            m_.acquire_write();
        }

        ~write_guard()
        {
            m_.release_write();
        }
    };

    typedef write_guard guard;

};

} // namespace concurrency_
} // namespace zi

#endif
