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

#ifndef ZI_CONCURRENCY_CONDITION_VARIABLE_HPP
#define ZI_CONCURRENCY_CONDITION_VARIABLE_HPP 1

#include <zi/concurrency/config.hpp>

#if defined( ZI_HAS_PTHREADS )
#  include <zi/concurrency/pthread/condition_variable.hpp>
#
#elif defined( ZI_HAS_WINTHREADS )
#  include <zi/concurrency/win32/condition_variable.hpp>
#
#else
#  error "add other"
#endif

namespace zi {

typedef concurrency_::condition_variable condition_variable;

} // namespace zi

#endif
