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

#ifndef ZI_CONCURRENCY_MUTEX_HPP
#define ZI_CONCURRENCY_MUTEX_HPP 1

#include <zi/concurrency/config.hpp>

#if defined( ZI_HAS_PTHREADS )
#  include <zi/concurrency/pthread/mutex_types.hpp>
#
#elif defined( ZI_HAS_WINTHREADS )
#  include <zi/concurrency/win32/mutex_types.hpp>
#
#else
#  error "add other"
#endif

namespace zi {


struct mutex: concurrency_::mutex_default
{
    typedef concurrency_::mutex_adaptive  adaptive;
    typedef concurrency_::mutex_recursive recursive;
};

// alternative:
// typedef concurrency_::mutex_default   mutex;

typedef concurrency_::mutex_adaptive  adaptive_mutex;
typedef concurrency_::mutex_recursive recursive_mutex;


template< class Class, class MutexTag = concurrency_::mutex_default_tag >
class class_mutex: private concurrency_::mutex_tpl< MutexTag >
{
public:

    typedef class_mutex< Class, MutexTag > type;

    typedef typename class_mutex< Class, concurrency_::mutex_recursive_tag >::type recursive;
    typedef typename class_mutex< Class, concurrency_::mutex_adaptive_tag  >::type adaptive;

private:

    typedef concurrency_::mutex_tpl< MutexTag > base_mutex_type;

    class_mutex(): base_mutex_type() {};
    ~class_mutex() {};
    class_mutex( const class_mutex< Class, MutexTag >& );
    class_mutex& operator=( const class_mutex< Class, MutexTag >& );

public:

    static concurrency_::mutex_tpl< MutexTag >& instance()
    {
        static class_mutex< Class, MutexTag > instance;
        return instance;
    }

    static bool try_lock()
    {
        return class_mutex< Class, MutexTag >::instance().try_lock();
    }

    static void lock()
    {
        class_mutex< Class, MutexTag >::lock();
    }

    static void unlock()
    {
        class_mutex< Class, MutexTag >::unlock();
    }

    class guard: non_copyable
    {
    public:
        guard()
        {
            class_mutex< Class, MutexTag >::instance().lock();
        }

        ~guard()
        {
            class_mutex< Class, MutexTag >::instance().unlock();
        }
    };

};


} // namespace zi

#endif
