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

#ifndef ZI_ZARGS_DETAIL_SIMPLE_LEXICAL_CAST_HPP
#define ZI_ZARGS_DETAIL_SIMPLE_LEXICAL_CAST_HPP 1

#include <typeinfo>
#include <exception>
#include <sstream>
#include <string>

namespace zi {
namespace zargs_ {

class bad_lexical_cast: public std::bad_cast
{
private:
    const std::type_info *source_type_;
    const std::type_info *target_type_;

public:
    bad_lexical_cast():
        source_type_( &typeid( void )),
        target_type_( &typeid( void ))
    {
    }

    bad_lexical_cast( const std::type_info &source_type,
                      const std::type_info &target_type ):
        source_type_( &source_type),
        target_type_( &target_type)
    {
    }

    const std::type_info &source_type() const
    {
        return *source_type_;
    }

    const std::type_info &target_type() const
    {
        return *target_type_;
    }

    virtual const char *what() const throw()
    {
        return "bad lexical cast: "
            "source type value could not be interpreted as target";
    }

    virtual ~bad_lexical_cast() throw()
    {
    }

};

namespace detail {

template< class Target, class Source >
struct lexical_caster
{
    static inline Target cast_it( const Source& source )
    {
        Target ret;
        std::stringstream ss;

        if ( ss << source && ss >> ret )
        {
            if ( ss.eof() )
            {
                return ret;
            }
        }

        throw bad_lexical_cast( typeid( Source ), typeid( Target ) );
    }
};


template< class Source >
struct lexical_caster< std::string, Source >
{
    static inline std::string cast_it( const Source& source )
    {
        std::ostringstream oss;

        if ( oss << source )
        {
            return oss.str();
        }

        throw bad_lexical_cast( typeid( Source ), typeid( std::string ) );
    }
};


} // namespace detail

template< class Target, class Source >
Target lexical_cast( const Source& source )
{
    return detail::lexical_caster< Target, Source >::cast_it( source );
}

} // namespace zargs_
} // namespace zi

#endif
