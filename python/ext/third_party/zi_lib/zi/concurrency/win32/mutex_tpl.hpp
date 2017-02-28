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

#ifndef ZI_CONCURRENCY_WIN32_MUTEX_TPL_HPP
#define ZI_CONCURRENCY_WIN32_MUTEX_TPL_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/win32/mutex_tags.hpp>
#include <zi/concurrency/win32/default_mutex.hpp>
#include <zi/concurrency/win32/recursive_mutex.hpp>

namespace zi {
namespace concurrency_ {

template< class PtMutexTag > class mutex_tpl;

template<> struct mutex_tpl< mutex_default_tag >  : default_mutex  {};
template<> struct mutex_tpl< mutex_adaptive_tag > : default_mutex  {};
template<> struct mutex_tpl< mutex_recursive_tag >: recursive_mutex{};

// alternative:
// template<> class mutex_tpl< mutex_recursive_tag >: recursive_spinlock;


} // namespace concurrency_
} // namespace zi

#endif
