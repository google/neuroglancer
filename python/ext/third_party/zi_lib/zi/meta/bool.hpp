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

#ifndef ZI_META_BOOL_HPP
#define ZI_META_BOOL_HPP 1

#include <zi/meta/true_type.hpp>
#include <zi/meta/false_type.hpp>
#include <zi/meta/null_type.hpp>

namespace zi {
namespace meta {

template< bool B > struct bool_c;

template<> struct bool_c< true  >: true_  {};
template<> struct bool_c< false >: false_ {};

} // namespace meta
} // namespace zi

#endif
