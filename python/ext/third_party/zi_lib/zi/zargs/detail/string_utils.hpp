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

#ifndef ZI_ZARGS_DETAIL_STRING_UTILS_HPP
#define ZI_ZARGS_DETAIL_STRING_UTILS_HPP 1

#include <string>
#include <cstddef>
#include <cstdlib>

namespace zi {
namespace zargs_ {
namespace detail {

inline std::string to_lower( const std::string& s )
{
    std::size_t len = s.size();
    std::string ret = s;

    for ( std::size_t i = 0; i < len; ++i )
    {
        ret[i] = static_cast< char >( std::tolower( s[i] ) );
    }

    return ret;
}

template< class Container >
inline void explode( Container &ret, const std::string& source, char splitter = ' ' )
{
    std::size_t startpos;
    std::size_t pos  = 0;
    std::size_t npos = std::string::npos;

    std::string tmp;
    std::string src = source;

    std::size_t length = src.size();

    while (pos != npos && pos < length)
    {
        startpos = pos;
        pos = src.find_first_of(splitter, pos);

        if (pos != 0)
        {
            tmp = source.substr(startpos, pos-startpos);
            ret.push_back(tmp);
            if (pos != npos)
            {
                ++pos;
            }
        }
        else
        {
            break;
        }
    }
}

inline bool begins_with( const std::string &b, const std::string &s )
{
    if ( s.size() < b.size() )
    {
        return false;
    }
    return ( b == s.substr( 0, b.size() ) );
}

inline std::string strip_quotes( const std::string& s )
{
    std::size_t len = s.size();

    if (len < 2)
    {
        return s;
    }

    if ( ( s[0] == '"'  && s[ len - 1 ] == '"' ) ||
         ( s[0] == '\'' && s[ len - 1 ] == '\'') )
    {
        std::string ret( s.begin() + 1, s.end() - 1 );
        return ret;
    }

    return s;
}


} // namespace detail
} // namespace zargs_
} // namespace zi

#endif
