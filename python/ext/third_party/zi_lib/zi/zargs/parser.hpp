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

#ifndef ZI_ZARGS_PARSER_HPP
#define ZI_ZARGS_PARSER_HPP 1

#include <zi/zargs/detail/string_utils.hpp>
#include <zi/zargs/detail/lexical_cast.hpp>

#include <utility>
#include <vector>
#include <set>
#include <map>

namespace zi {
namespace zargs_ {

template< class Type > struct parser
{
    bool parse( Type* target, const std::string &source ) const
    {
        try {
            *target = lexical_cast< Type >( source );
            return true;
        }
        catch (...)
        {
            return false;
        }
    }
};

template<> struct parser< bool >
{
public:
    bool parse( bool* target, const std::string &source ) const
    {
        try {
            *target = lexical_cast< bool >( source );
            return true;
        }
        catch (...)
        {
            std::string s( detail::to_lower( source ) );

            if ( s == "t" || s == "true" || s == "yes" || s == "y" )
            {
                *target = true;
                return true;
            }

            if ( s == "f" || s == "false" || s == "no" || s == "n" )
            {
                *target = false;
                return true;
            }

            return false;
        }
    }
};

template<> struct parser< std::string >
{
    bool parse( std::string* target, const std::string &source ) const
    {
        *target = std::string( source );
        return true;
    }
};


template< class Type, class Compare, class Alloc >
struct parser< std::set< Type, Compare, Alloc > >
{
    bool parse( std::set< Type, Compare, Alloc >* target, const std::string &source ) const
    {
        std::vector< std::string > all;
        detail::explode( all, source, ',' );

        for ( std::vector< std::string >::const_iterator it = all.begin(); it != all.end(); ++it )
        {
            try
            {
                target->insert( lexical_cast< Type >( *it ) );
            }
            catch (...)
            {
                return false;
            }
        }

        return true;
    }
};

template< class Type, class Alloc >
struct parser< std::vector< Type, Alloc > >
{
    bool parse( std::vector< Type, Alloc >* target, const std::string &source ) const
    {
        std::vector< std::string > all;
        detail::explode( all, source, ',' );

        for ( std::vector< std::string >::const_iterator it = all.begin(); it != all.end(); ++it )
        {
            try
            {
                target->push_back( lexical_cast< Type >( *it ) );
            }
            catch (...)
            {
                return false;
            }
        }
        return true;
    }
};

template<> struct parser< std::map< std::string, bool > >
{
    bool parse( std::map< std::string, bool >* target, const std::string &source ) const
    {
        std::vector< std::string > all;
        detail::explode( all, source, ',' );

        for ( std::vector< std::string >::const_iterator it = all.begin(); it != all.end(); ++it )
        {
            try
            {
                target->insert( std::make_pair( *it, true) );
            }
            catch (...) {
                return false;
            }
        }
        return true;
    }
};


} // namespace zargs_
} // namespace zi

#endif
