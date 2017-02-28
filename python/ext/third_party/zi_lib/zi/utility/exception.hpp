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

#ifndef ZI_UTILITY_EXCEPTION_HPP
#define ZI_UTILITY_EXCEPTION_HPP 1

#include <zi/utility/string_printf.hpp>
#include <exception>
#include <string>

namespace zi {
namespace exception_ {

class exception: public std::exception
{
protected:
    const std::string message_;

public:
    exception(): message_()
    {
    }

    exception( const std::string& message ):
        message_( message )
    {
    }

    virtual ~exception() throw()
    {
    }

    virtual const char* what() const throw()
    {
        if ( message_.empty() )
        {
            return "default exception";
        }
        else
        {
            return message_.c_str();
        }
    }

};

} // namespace exception_

using exception_::exception;

} // namespace zi

#define ZI_EXCEPTION_STRINIGIFY_H( what ) #what
#define ZI_EXCEPTION_STRINIGIFY( what ) ZI_EXCEPTION_STRINIGIFY_H( what )

#define ZI_THROW( message )                                             \
    throw ::zi::exception( std::string( message ) +                     \
                           " [" + __FILE__ + ": " +                     \
                           ZI_EXCEPTION_STRINIGIFY( __LINE__ ) + "]" )

#define ZI_THROWF( etype, fmt, ... )                                    \
    throw etype ( ::zi::string_printf( fmt, ##__VA_ARGS__ ) +           \
                  " [" + __FILE__ + ": " +                              \
                  ZI_EXCEPTION_STRINIGIFY( __LINE__ ) + "]" )

#define ZI_THROW_ON( cond, message )            \
    if ( cond ) ZI_THROW( message )

#endif
