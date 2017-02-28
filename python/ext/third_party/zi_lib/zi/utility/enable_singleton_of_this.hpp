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

#ifndef ZI_UTILITY_ENABLE_SINGLETON_OF_THIS_HPP
#define ZI_UTILITY_ENABLE_SINGLETON_OF_THIS_HPP 1

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/singleton.hpp>

namespace zi {
namespace singleton_ {

template< class Type >
class enable_singleton_of_this: non_copyable
{
public:

    template< class Tag > static Type& instance()
    {
        return singleton< Type >::template instance< Tag >();
    }

    static Type& instance()
    {
        return singleton< Type >::instance();
    }

};

} // namespace singleton_

using singleton_::enable_singleton_of_this;

} // namespace zi

#endif
