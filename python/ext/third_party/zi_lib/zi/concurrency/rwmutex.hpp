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

#ifndef ZI_CONCURRENCY_RWMUTEX_HPP
#define ZI_CONCURRENCY_RWMUTEX_HPP 1

#include <zi/concurrency/config.hpp>

#if defined( ZI_HAS_PTHREADS )
#  include <zi/concurrency/pthread/rwmutex.hpp>
#
#elif defined( ZI_HAS_WINTHREADS )
#  include <zi/concurrency/win32/rwmutex.hpp>
#
#else
#  error "threading platform not supported"
#endif

namespace zi {
typedef concurrency_::rwmutex_impl rwmutex;

template< class Class >
class class_rwmutex: private rwmutex
{
public:

    typedef class_rwmutex< Class > type;

private:

    class_rwmutex(): rwmutex() {};
    ~class_rwmutex() {};
    class_rwmutex( const class_rwmutex< Class >& );
    class_rwmutex& operator=( const class_rwmutex< Class >& );

public:

    static rwmutex& instance()
    {
        static class_rwmutex< Class > instance;
        return instance;
    }

    static bool try_acquire_read()
    {
        return class_rwmutex< Class >::instance().try_acquire_read();
    }

    static bool try_acquire_write()
    {
        return class_rwmutex< Class >::instance().try_acquire_write();
    }

    static void acquire_read()
    {
        class_rwmutex< Class >::instance().acquire_read();
    }

    static void acquire_write()
    {
        class_rwmutex< Class >::instance().acquire_write();
    }

    static void release_read()
    {
        class_rwmutex< Class >::instance().release_read();
    }

    static void release_write()
    {
        class_rwmutex< Class >::instance().release_write();
    }

    class read_guard: zi::non_copyable
    {
    public:
        read_guard()
        {
            class_rwmutex< Class >::instance().acquire_read();
        }

        ~read_guard()
        {
            class_rwmutex< Class >::instance().release_read();
        }
    };

    class write_guard: zi::non_copyable
    {
    public:
        write_guard()
        {
            class_rwmutex< Class >::instance().acquire_write();
        }

        ~write_guard()
        {
            class_rwmutex< Class >::instance().release_write();
        }
    };

};

} // namespace zi

#endif
