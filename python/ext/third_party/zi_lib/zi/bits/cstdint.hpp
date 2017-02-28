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

#ifndef ZI_BITS_CSTDINT_HPP
#define ZI_BITS_CSTDINT_HPP 1

#include <zi/config/config.hpp>

#ifdef __GXX_EXPERIMENTAL_CXX0X__
#  include <cstdint>
#  define ZI_CSTDINT_NAMESPACE ::std
#else
#  if defined( ZI_USE_TR1 ) || defined( ZI_NO_BOOST )
#    include <tr1/cstdint>
#    define ZI_CSTDINT_NAMESPACE ::std::tr1
#  else
#    include <boost/cstdint.hpp>
#    define ZI_NEED_INTPTR_TYPES
#    define ZI_CSTDINT_NAMESPACE ::boost
#  endif
#endif

namespace zi {

using ZI_CSTDINT_NAMESPACE::int8_t;
using ZI_CSTDINT_NAMESPACE::int16_t;
using ZI_CSTDINT_NAMESPACE::int32_t;
using ZI_CSTDINT_NAMESPACE::int64_t;

using ZI_CSTDINT_NAMESPACE::int_fast8_t;
using ZI_CSTDINT_NAMESPACE::int_fast16_t;
using ZI_CSTDINT_NAMESPACE::int_fast32_t;
using ZI_CSTDINT_NAMESPACE::int_fast64_t;

using ZI_CSTDINT_NAMESPACE::int_least8_t;
using ZI_CSTDINT_NAMESPACE::int_least16_t;
using ZI_CSTDINT_NAMESPACE::int_least32_t;
using ZI_CSTDINT_NAMESPACE::int_least64_t;

using ZI_CSTDINT_NAMESPACE::intmax_t;

using ZI_CSTDINT_NAMESPACE::uint8_t;
using ZI_CSTDINT_NAMESPACE::uint16_t;
using ZI_CSTDINT_NAMESPACE::uint32_t;
using ZI_CSTDINT_NAMESPACE::uint64_t;

using ZI_CSTDINT_NAMESPACE::uint_fast8_t;
using ZI_CSTDINT_NAMESPACE::uint_fast16_t;
using ZI_CSTDINT_NAMESPACE::uint_fast32_t;
using ZI_CSTDINT_NAMESPACE::uint_fast64_t;

using ZI_CSTDINT_NAMESPACE::uint_least8_t;
using ZI_CSTDINT_NAMESPACE::uint_least16_t;
using ZI_CSTDINT_NAMESPACE::uint_least32_t;
using ZI_CSTDINT_NAMESPACE::uint_least64_t;

using ZI_CSTDINT_NAMESPACE::uintmax_t;

#if defined( ZI_NEED_INTPTR_TYPES )
using ::intptr_t;
using ::uintptr_t;
#else
using ZI_CSTDINT_NAMESPACE::uintptr_t;
using ZI_CSTDINT_NAMESPACE::intptr_t;
#endif

} // namespace zi

#undef ZI_NEED_INTPTR_TYPES
#undef ZI_CSTDINT_NAMESPACE
#endif
