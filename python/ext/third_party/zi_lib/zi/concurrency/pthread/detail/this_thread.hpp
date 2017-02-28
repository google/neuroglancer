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

#ifndef ZI_CONCURRENCY_PTHREAD_DETAIL_THIS_THREAD_HPP
#define ZI_CONCURRENCY_PTHREAD_DETAIL_THIS_THREAD_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/bits/cstdint.hpp>

#include <pthread.h>
#include <sched.h>

namespace zi {
namespace concurrency_ {

namespace this_thread {

inline void usleep_nt( int64_t usec )
{
    usleep( usec );
}

inline pthread_t id()
{
    return pthread_self();
}

inline void yield()
{
    sched_yield();
}


} // namespace this_thread

} // namespace concurrency_
} // namespace zi

#endif

