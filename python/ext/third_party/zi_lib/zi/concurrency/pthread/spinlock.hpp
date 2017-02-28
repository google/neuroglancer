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

#ifndef ZI_CONCURRENCY_PTHREAD_SPINLOCK_HPP
#define ZI_CONCURRENCY_PTHREAD_SPINLOCK_HPP 1

#include <zi/concurrency/config.hpp>

#if defined( ZI_HAS_PT_SPINLOCK )
#  include <zi/concurrency/detail/mutex_guard.hpp>
#  include <zi/concurrency/detail/mutex_pool.hpp>
#  include <zi/utility/non_copyable.hpp>
#  include <zi/utility/assert.hpp>
#  include <pthread.h>
#
#else
#  include <zi/concurrency/pthread/mutex_types.hpp>
#
#endif

namespace zi {
namespace concurrency_ {

#if defined( ZI_HAS_PT_SPINLOCK )

class spinlock: non_copyable
{
private:

    mutable pthread_spinlock_t spin_;

public:

    spinlock(): spin_(0)
    {
        ZI_VERIFY_0( pthread_spin_init( &spin_, 0 ) );
    }

    ~spinlock()
    {
        ZI_VERIFY_0( pthread_spin_destroy( &spin_ ) );
    }

    inline bool try_lock() const
    {
        return pthread_spin_trylock( &spin_ ) == 0;
    }

    inline void lock() const
    {
        ZI_VERIFY_0( pthread_spin_lock( &spin_ ) );
    }

    inline void unlock() const
    {
        ZI_VERIFY_0( pthread_spin_unlock( &spin_ ) );
    }

    typedef mutex_guard< spinlock > guard;

    template< class Tag >
    struct pool: mutex_pool< Tag, spinlock > { };

};

#else

typedef mutex_adaptive spinlock;

#endif

} // namespace concurrency_
} // namespace zi

#endif
