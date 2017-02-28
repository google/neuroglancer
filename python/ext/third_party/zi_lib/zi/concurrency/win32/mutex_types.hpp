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

#ifndef ZI_CONCURRENCY_WIN32_MUTEX_TYPES_HPP
#define ZI_CONCURRENCY_WIN32_MUTEX_TYPES_HPP 1

#include <zi/concurrency/win32/mutex_tpl.hpp>

namespace zi {
namespace concurrency_ {

typedef mutex_tpl< mutex_default_tag >   mutex_default;
typedef mutex_tpl< mutex_adaptive_tag >  mutex_adaptive;
typedef mutex_tpl< mutex_recursive_tag > mutex_recursive;

} // namespace concurrency_
} // namespace zi

#endif
