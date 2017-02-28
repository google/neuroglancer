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

#ifndef ZI_CONCURRENCY_THREAD_TYPES_HPP
#define ZI_CONCURRENCY_THREAD_TYPES_HPP 1

#include <zi/concurrency/config.hpp>

#if defined( ZI_HAS_PTHREADS )
#  include <zi/concurrency/pthread/types.hpp>
#
#elif defined( ZI_HAS_WINTHREADS )
#  include <zi/concurrency/win32/types.hpp>
#
#else
#  error "add other"
#endif

#include <zi/concurrency/detail/thread_info.hpp>
#include <zi/concurrency/detail/all_threads_data.hpp>
#include <zi/utility/singleton.hpp>

namespace zi {
namespace concurrency_ {


typedef detail::thread_info< thread_id_type, native_thread_handle_type >      thread_info      ;
typedef detail::all_threads_data< thread_id_type, native_thread_handle_type > all_threads_data ;


namespace {

static all_threads_data &all_threads_info = singleton< all_threads_data >::instance();

}


} // namespace concurrency_

using zi::concurrency_::thread_id_type;
using zi::concurrency_::native_thread_handle_type;

} // namespace zi

#endif
