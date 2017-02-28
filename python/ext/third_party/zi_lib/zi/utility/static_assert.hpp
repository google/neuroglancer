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

#ifndef ZI_UTILITY_STATIC_ASSERT_HPP
#define ZI_UTILITY_STATIC_ASSERT_HPP 1

#include <zi/config/config.hpp>
#include <zi/zpp/glue.hpp>

namespace zi {

template< bool Condition > struct STATIC_ASSERT_FAILED;

template<> struct STATIC_ASSERT_FAILED< true > { static const bool value = true; };

template< int I > struct static_assert_test { };

#define ZI_STATIC_ASSERT( value, message )                              \
                                                                        \
    typedef ::zi::static_assert_test                                    \
    < sizeof( ::zi::STATIC_ASSERT_FAILED< (bool)( value ) > ) >         \
    ZiPP_GLUE( message##_at_line_, __LINE__ )

} // namespace zi

#endif
