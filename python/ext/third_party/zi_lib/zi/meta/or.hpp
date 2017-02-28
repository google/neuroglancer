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

#ifndef ZI_META_OR_HPP
#define ZI_META_OR_HPP 1

#include <zi/meta/true_type.hpp>
#include <zi/meta/false_type.hpp>
#include <zi/meta/null_type.hpp>
#include <zi/meta/if.hpp>

namespace zi {
namespace meta {

template< class V1,
          class V2 = null_type,
          class V3 = null_type, class V4 = null_type,
          class V5 = null_type, class V6 = null_type,
          class V7 = null_type, class V8 = null_type,
          class V9 = null_type, class Va = null_type,
          class Vb = null_type, class Vc = null_type,
          class Vd = null_type, class Ve = null_type,
          class Vf = null_type
          >
struct or_: if_< V1,
                 true_,
                 or_< V2, V3, V4, V5, V6, V7, V8, V9, Va, Vb, Vc, Vd, Ve, Vf > >::type
{};

template< class V2, class V3, class V4, class V5, class V6,
          class V7, class V8, class V9, class Va, class Vb,
          class Vc, class Vd, class Ve, class Vf
          >
struct or_< null_type, V2, V3, V4, V5, V6, V7, V8, V9, Va, Vb, Vc, Vd, Ve, Vf >: false_ {};


} // namespace meta
} // namespace zi

#endif
