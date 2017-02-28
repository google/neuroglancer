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

#ifndef ZI_ZUNIT_EXCEPTION_HPP
#define ZI_ZUNIT_EXCEPTION_HPP 1

#include <zi/zunit/config.hpp>
#include <zi/zunit/test_case.hpp>

#include <exception>
#include <string>
#include <sstream>

namespace zi {
namespace zunit {

class exception: public std::exception
{
public:

   enum exception_type
    {
        UNKNOWN = 0,
        UNARY_CHECK,
        BINARY_CHECK,
        THROW_CHECK
    };

    exception( exception_type tp, test_case *tst, const std::string &check,
               const std::string &what, int line ):
        type_( tp ),
        test_( tst ),
        line_( line ),
        check_( check ),
        what_( what),
        message_()
    {
    }

    exception( exception_type tp, test_case *tst, const std::string &check, int line ):
        type_( tp ),
        test_( tst ),
        line_( line ),
        check_( check ),
        what_(),
        message_()
    {
    }

    template< class Exception > explicit exception( const Exception &e, int line ):
        type_( UNKNOWN ),
        test_( 0 ),
        line_( line ),
        check_(),
        what_( e.what() ),
        message_()
    {
    }

    virtual ~exception() throw()
    {
    }

    virtual const char* arg       ( int ) const
    {
        return "";
    }

    virtual const char* arg_type  ( int ) const
    {
        return "";
    }

    virtual const char* arg_value ( int ) const
    {
        return "";
    }

    virtual const char* what() const throw()
    {
        if ( message_.empty() )
        {
            std::ostringstream ss;
            ss << test_->name() << " [" << test_->file() << ": " << line_ << "]\n";

            switch ( type_ )
            {

            case UNKNOWN:
                ss << "\t" << what_;
                break;

            case UNARY_CHECK:
                ss << "\t" << check_ << "( " << arg( 0 ) << " ) failed\n\twith ";
                ss << arg( 0 ) << " = " << arg_value( 0 );
                ss << " < " << arg_type( 0 ) << " >\n";
                break;

            case BINARY_CHECK:
                ss << "\t" << check_ << "( " << arg( 0 ) << ", " << arg( 1 )
                   << " ) failed\n\twith:\n\t\t";

                ss << arg( 0 ) << " = " << arg_value( 0 )
                   << " < " << arg_type( 0 ) << " >\n\t\t";

                ss << arg( 1 ) << " = " << arg_value( 1 )
                   << " < " << arg_type( 1 ) << " >\n\t\t";

                break;

            case THROW_CHECK:
                ss << "\t" << check_ << "( " << arg( 0 );
                if ( arg( 1 ) ) {
                    ss << ", " << arg( 1 );
                }
                ss << " ) failed\n\t";
                if ( what_.empty() ) {
                    ss << "No exception was thrown\n";
                } else {
                    ss << "Wrong exception was thrown\n\twhat():  " << what_;
                }

            default:
                break;

            }

            std::string &msg_ = const_cast< std::string& >( message_ );
            msg_ = ss.str();

        }
        return message_.c_str();
    }

protected:
    exception_type  type_   ;
    test_case      *test_   ;
    int             line_   ;
    std::string     check_  ;
    std::string     what_   ;
    std::string     message_;
};

struct dummy_exception
{
    virtual const char* what() const throw()
    {
        return "";
    }
};

template< class T > struct choose_exception
{
    typedef std::exception type;
};

template<> struct choose_exception< std::exception >
{
    typedef dummy_exception type;
};

} // namespace zunit
} // namespace zi

#endif
