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

#ifndef ZI_UTILITY_THIS_FUNCTION_HPP
#define ZI_UTILITY_THIS_FUNCTION_HPP 1
#
#include <zi/config/config.hpp>
#

namespace zi {
namespace private_ {

inline void macros_should_be_defined_inside_a_function()
{

#if defined( ZI_CXX_GCC )
#  define ZI_THIS_FUNCTION __PRETTY_FUNCTION__
#
#elif defined( __FUNCSIG__ )
#  define ZI_THIS_FUNCTION __FUNCSIG__
#
#elif defined( __STDC_VERSION__ ) && ( __STDC_VERSION__ >= 199901 )
#  define ZI_THIS_FUNCTION __func__
#
#else
#  define ZI_THIS_FUNCTION "(unknown)"
#
#endif

}

} // namespace private_
} // namespace zi

#endif
