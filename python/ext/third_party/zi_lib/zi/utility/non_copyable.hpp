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

#ifndef ZI_UTILITY_NON_COPYABLE_HPP
#define ZI_UTILITY_NON_COPYABLE_HPP 1

namespace zi {
namespace non_copyable_ {

class non_copyable
{
protected:
     non_copyable() {}
    ~non_copyable() {}

private:

    non_copyable( const non_copyable& );
    const non_copyable& operator=( const non_copyable& );

};

} // namespace non_copyable_

using non_copyable_::non_copyable;

} // namespace zi

#endif
