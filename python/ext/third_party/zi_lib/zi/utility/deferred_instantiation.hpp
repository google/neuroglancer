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

#ifndef ZI_UTILITY_DEFERRED_INSTANTIATION_HPP
#define ZI_UTILITY_DEFERRED_INSTANTIATION_HPP 1

#include <zi/config/config.hpp>

namespace zi {

template< class TypeToInstantiate,
          class WaitOn1 = void, class WaitOn2 = void, class WaitOn3 = void,
          class WaitOn4 = void, class WaitOn5 = void, class WaitOn6 = void,
          class WaitOn7 = void, class WaitOn8 = void, class WaitOn9 = void,
          class WaitOna = void, class WaitOnb = void, class WaitOnc = void,
          class WaitOnd = void, class WaitOne = void, class WaitOnf = void
          >
struct deferred_instantiation
{
    typedef TypeToInstantiate type;
};

} // namespace zi

#if defined( ZI_CXX_MSVC )
#  define ZI_DEFERRED_INSTANTIATION( _c, ... ) _c
#else
#  define ZI_DEFERRED_INSTANTIATION( _c, ... )                  \
    ::zi::deferred_instantiation< _c, ##__VA_ARGS__ >::type
#endif

#endif
