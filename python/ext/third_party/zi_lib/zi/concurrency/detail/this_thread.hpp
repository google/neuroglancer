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

#ifndef ZI_CONCURRENCY_DETAIL_THIS_THREAD_HPP
#define ZI_CONCURRENCY_DETAIL_THIS_THREAD_HPP 1

#include <zi/concurrency/config.hpp>

#if defined( ZI_HAS_PTHREADS )
#  include <zi/concurrency/pthread/detail/this_thread.hpp>
#
#elif defined( ZI_HAS_WINTHREADS )
#  include <zi/concurrency/win32/detail/this_thread.hpp>
#
#else
#  error "add other"
#
#endif

#include <zi/concurrency/thread_types.hpp>
#include <zi/utility/assert.hpp>
#include <zi/time/interval.hpp>
#include <zi/bits/cstdint.hpp>

namespace zi {
namespace concurrency_ {
namespace this_thread {


template< int64_t I >
void sleep( const interval::detail::interval_tpl< I > &i )
{
    shared_ptr< thread_info > ti = all_threads_info.get_thread( id() );

    if ( ti )
    {
        ti->sleep( i );
    }
    else
    {
        usleep_nt( i.usecs() );
    }
}

inline void sleep( int64_t msec )
{
    shared_ptr< thread_info > ti = all_threads_info.get_thread( id() );

    if ( ti )
    {
        ti->sleep( msec );
    }
    else
    {
        usleep_nt( msec * 1000 );
    }
}

inline void usleep( int64_t usec )
{
    shared_ptr< thread_info > ti = all_threads_info.get_thread( id() );

    if ( ti )
    {
        ti->usleep( usec );
    }
    else
    {
        usleep_nt( usec );
    }
}


} // namespace this_thread
} // namespace concurrency_
} // namespace zi

#endif
