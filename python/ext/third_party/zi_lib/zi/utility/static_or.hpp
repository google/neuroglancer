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

#ifndef ZI_UTILITY_STATIC_OR_HPP
#define ZI_UTILITY_STATIC_OR_HPP 1

namespace zi {


template< bool V1, bool V2,
          bool V3 = false, bool V4 = false, bool V5 = false, bool V6 = false,
          bool V7 = false, bool V8 = false, bool V9 = false, bool VA = false >
struct static_or;

template< bool V1, bool V2, bool V3, bool V4, bool V5,
          bool V6, bool V7, bool V8, bool V9, bool VA >
struct static_or
{
    static const bool value = true;
};

template<>
struct static_or< false, false, false, false, false,
                  false, false, false, false, false >
{
    static const bool value = false;
};


template< bool V1, bool V2,
          bool V3 = false, bool V4 = false, bool V5 = false, bool V6 = false,
          bool V7 = false, bool V8 = false, bool V9 = false, bool VA = false >
struct or_;

template< bool V1, bool V2, bool V3, bool V4, bool V5,
          bool V6, bool V7, bool V8, bool V9, bool VA >
struct or_
{
    static const bool value = true;
};

template<>
struct or_< false, false, false, false, false,
            false, false, false, false, false >
{
    static const bool value = false;
};


} // namespace zi

#endif
