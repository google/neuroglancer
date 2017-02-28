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

#ifndef ZI_META_AND_HPP
#define ZI_META_AND_HPP 1

#include <zi/meta/true_type.hpp>
#include <zi/meta/false_type.hpp>
#include <zi/meta/null_type.hpp>
#include <zi/meta/if.hpp>

namespace zi {
namespace meta {

template< class V1,
          class V2 = null_type,
          class V3 = null_type, class V4 = null_type,
          class V5 = null_type, class V6 = null_type >
struct and_: if_< V1,
                  and_< V2, V3, V4, V5, V6 >,
                  false_ >::type
{};

template< class V2, class V3, class V4, class V5, class V6 >
struct and_< null_type, V2, V3, V4, V5, V6 >: true_ {};


} // namespace meta
} // namespace zi

#endif
