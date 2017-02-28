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

#ifndef ZI_UTILITY_SINGLETON_HPP
#define ZI_UTILITY_SINGLETON_HPP 1

namespace zi {
namespace singleton_ {

template< class Type > class singleton: private Type
{
private:

    singleton() {};
    ~singleton() {};
    singleton( const singleton< Type >& );
    singleton& operator=( const singleton< Type >& );

public:

    typedef singleton< Type > type;

    template< class Tag > static Type& instance()
    {
        static singleton< Type > instance;
        return instance;
    }

    static Type& instance()
    {
        static singleton< Type > instance;
        return instance;
    }

};

template< class Type > Type& singleton_of()
{
    return singleton< Type >::instance();
}

} // namespace singleton_

using singleton_::singleton;
using singleton_::singleton_of;

} // namespace zi

#endif
