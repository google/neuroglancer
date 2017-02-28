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

#ifndef ZI_CONCURRENCY_WIN32_SPINLOCK_HPP
#define ZI_CONCURRENCY_WIN32_SPINLOCK_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/detail/mutex_guard.hpp>
#include <zi/concurrency/detail/mutex_pool.hpp>
#include <zi/concurrency/win32/detail/primitives.hpp>

#include <zi/utility/non_copyable.hpp>

// silly int->bool warning in msvc
#if defined( ZI_CXX_MSVC )
#  pragma warning( push )
#  pragma warning( disable: 4800 )
#endif

namespace zi {
namespace concurrency_ {


class spinlock: non_copyable
{
private:
    mutable win32::critical_section cs_;

public:

    spinlock()
    {
        win32::InitializeCriticalSection( &cs_ );
    }

    ~spinlock()
    {
        win32::DeleteCriticalSection( &cs_ );
    }

    inline bool try_lock() const
    {
        return win32::TryEnterCriticalSection( &cs_ );
    }

    inline void lock() const
    {
        win32::EnterCriticalSection( &cs_ );
    }

    inline void unlock() const
    {
        win32::LeaveCriticalSection( &cs_ );
    }

    typedef mutex_guard< spinlock > guard;

    template< class Tag >
    struct pool: mutex_pool< Tag, spinlock > { };

};


} // namespace concurrency_
} // namespace zi

#if defined( ZI_CXX_MSVC )
#  pragma warning( pop )
#endif

#endif
