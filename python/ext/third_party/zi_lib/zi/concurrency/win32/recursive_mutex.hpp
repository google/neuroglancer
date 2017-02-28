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

#ifndef ZI_CONCURRENCY_WIN32_RECURSIVE_MUTEX_HPP
#define ZI_CONCURRENCY_WIN32_RECURSIVE_MUTEX_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/detail/mutex_guard.hpp>
#include <zi/concurrency/detail/mutex_pool.hpp>
#include <zi/concurrency/win32/detail/primitives.hpp>
#include <zi/concurrency/win32/detail/interlocked.hpp>
#include <zi/concurrency/win32/spinlock.hpp>
#include <zi/concurrency/win32/default_mutex.hpp>

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/assert.hpp>

namespace zi {
namespace concurrency_ {

// forward declarations
class condition_variable;
class event;

template< class Mutex >
class recursive_mutex_tpl: non_copyable
{
private:
    mutable win32::dword owner_;
    mutable win32::dword count_;
    Mutex                mutex_;

public:

    recursive_mutex_tpl(): owner_( 0 ), count_( 0 ), mutex_()
    {
    }

    ~recursive_mutex_tpl()
    {
        ZI_ASSERT_0( count_ );
        ZI_ASSERT_0( owner_ );
    }

    inline bool try_lock() const
    {
        win32::dword me = win32::GetCurrentThreadId();

        if ( owner_ == me )
        {
            ++count_;
            return true;
        }

        if ( mutex_.try_lock() )
        {
            ZI_ASSERT_0( count_ );
            ++count_;
            owner_ = me;
            return true;
        }

        return false;
    }

    inline void lock() const
    {
        win32::dword me = win32::GetCurrentThreadId();

        if ( owner_ == me )
        {
            ++count_;
        }
        else
        {
            mutex_.lock();
            ZI_ASSERT_0( count_ );
            ++count_;
            owner_ = me;
        }
    }

    inline void unlock() const
    {
        ZI_ASSERT( owner_ == win32::GetCurrentThreadId() );

        if ( --count_ == 0 )
        {
            owner_ = 0;
            mutex_.unlock();
        }
    }

    typedef mutex_guard< recursive_mutex_tpl< Mutex > > guard;

    template< class Tag >
    struct pool: mutex_pool< Tag, recursive_mutex_tpl< Mutex > > { };

    friend class condition_variable;
    friend class event;

};

typedef recursive_mutex_tpl< default_mutex > recursive_mutex;
typedef recursive_mutex_tpl< spinlock >      recursive_spinlock;

} // namespace concurrency_
} // namespace zi

#endif
