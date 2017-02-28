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

#ifndef ZI_UTILITY_STATIC_AND_HPP
#define ZI_UTILITY_STATIC_AND_HPP 1

namespace zi {


template< bool V1, bool V2,
          bool V3 = true, bool V4 = true, bool V5 = true, bool V6 = true,
          bool V7 = true, bool V8 = true, bool V9 = true, bool VA = true >
struct static_and;

template< bool V1, bool V2, bool V3, bool V4, bool V5,
          bool V6, bool V7, bool V8, bool V9, bool VA >
struct static_and
{
    static const bool value = false;
};

template<>
struct static_and< true, true, true, true, true,
                   true, true, true, true, true >
{
    static const bool value = true;
};


template< bool V1, bool V2,
          bool V3 = true, bool V4 = true, bool V5 = true, bool V6 = true,
          bool V7 = true, bool V8 = true, bool V9 = true, bool VA = true >
struct and_;

template< bool V1, bool V2, bool V3, bool V4, bool V5,
          bool V6, bool V7, bool V8, bool V9, bool VA >
struct and_
{
    static const bool value = false;
};

template<>
struct and_< true, true, true, true, true,
             true, true, true, true, true >
{
    static const bool value = true;
};


} // namespace zi

#endif
