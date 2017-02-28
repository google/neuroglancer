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

#ifndef ZI_CONCURRENCY_PTHREAD_RWMUTEX_HPP
#define ZI_CONCURRENCY_PTHREAD_RWMUTEX_HPP 1

#if defined( ZI_USE_PTHREAD_RWLOCK_T )
#  include <zi/concurrency/pthread/rwmutex_using_pthread_rwlock_t.hpp>
#else
#  include <zi/concurrency/detail/rwmutex_impl.hpp>
#endif

#endif
